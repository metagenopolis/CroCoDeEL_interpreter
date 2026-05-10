/* Pyodide-based CroCoDeEL runner in a Web Worker.
 *
 * Why a worker: Pyodide runs CPython in WASM on whichever JS thread
 * imported it. CroCoDeEL's `run_search_conta` blocks for 10–30 s on a
 * typical abundance table; if it ran on the main thread the page would
 * trigger Chrome's "page not responding" prompt (which is what we hit).
 * Hosting the runtime in a worker keeps the UI responsive and lets the
 * main thread stream progress updates back via postMessage.
 *
 * Protocol:
 *   main → worker: { type: "run", abundance: string,
 *                    probCutoff: number, rateCutoff: number,
 *                    filterLowAb: number }
 *   worker → main: { type: "progress", label: string }
 *                  { type: "version", version: string }
 *                  { type: "log", stream: "stdout"|"stderr", line: string }
 *                  { type: "done", tsv: string }
 *                  { type: "error", message: string }
 */

// Pyodide runtime version + CDN base. Keep in sync with the main thread.
const PYODIDE_VERSION = "0.26.4";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

importScripts(`${PYODIDE_BASE}pyodide.js`);

let pyPromise = null;
const post = (msg) => self.postMessage(msg);

async function bootPyodide() {
  if (pyPromise) return pyPromise;
  pyPromise = (async () => {
    post({ type: "progress", label: "Booting Python runtime…" });
    // eslint-disable-next-line no-undef
    const py = await loadPyodide({ indexURL: PYODIDE_BASE });
    // Capture stdout / stderr so the main thread can stream them
    // live behind the "Show real-time output" checkbox. We use the
    // raw (per-byte) callback and flush a line on either \n OR \r
    // so tqdm's carriage-return progress updates also surface live
    // — the default `batched` mode only fires on \n and would buffer
    // the entire bar until completion.
    // Pyodide's `raw` callback fires once per *byte*. tqdm and any
    // other unicode-emitting code (block-character progress bars,
    // Greek letters, etc.) writes multi-byte UTF-8 sequences, so we
    // must accumulate the bytes and decode them as a unit — feeding
    // each byte to String.fromCharCode produces mojibake (the "å"
    // characters you may see otherwise).
    const decoder = new TextDecoder("utf-8");
    const makeCapture = (stream) => {
      let bytes = [];
      const flush = () => {
        if (bytes.length === 0) return;
        const text = decoder.decode(new Uint8Array(bytes));
        bytes = [];
        post({ type: "log", stream, line: text });
      };
      return {
        raw: (code) => {
          if (code === 10 /* \n */ || code === 13 /* \r */) {
            flush();
          } else {
            bytes.push(code);
            if (bytes.length > 4096) flush();
          }
        },
      };
    };
    py.setStdout(makeCapture("stdout"));
    py.setStderr(makeCapture("stderr"));
    post({
      type: "progress",
      label: "Loading scientific stack (numpy / pandas / scipy / scikit-learn / matplotlib)…",
    });
    await py.loadPackage([
      "micropip",
      "numpy",
      "pandas",
      "scikit-learn",
      "scipy",
      "matplotlib",
    ]);
    post({ type: "progress", label: "Installing CroCoDeEL via micropip…" });
    await py.runPythonAsync(`
import micropip
try:
    await micropip.install("crocodeel", keep_going=True)
except Exception:
    try:
        await micropip.install(["joblib", "tqdm"], keep_going=True)
    except Exception:
        pass
    await micropip.install("crocodeel", deps=False, keep_going=True)
    `);
    // Surface the installed CroCoDeEL version + the package's own
    // Defaults so the page can show the curator the values it would
    // run with if they don't override.
    try {
      const meta = await py.runPythonAsync(`
import importlib.metadata, json
try:
    v = importlib.metadata.version('crocodeel')
except Exception:
    v = '?'
defs = {}
try:
    from crocodeel.search_conta import Defaults
    for n in dir(Defaults):
        if n.startswith('_'):
            continue
        val = getattr(Defaults, n)
        if isinstance(val, (int, float, str, bool)):
            defs[n] = val
except Exception:
    pass
json.dumps({'version': v, 'defaults': defs})
      `);
      const parsed = JSON.parse(meta);
      post({
        type: "version",
        version: parsed.version,
        defaults: parsed.defaults || {},
      });
    } catch {
      // non-fatal — we still let the user run with their inputs
    }
    return py;
  })().catch((err) => {
    pyPromise = null;
    throw err;
  });
  return pyPromise;
}

const PYTHON_RUNNER = `
import io, os
import pandas as pd
from importlib.resources import files

# Mirror the CLI's load path: ab_table_utils.read_filter_normalize
# accepts a text file handle and the --filter-low-ab factor, returns
# the *normalized* DataFrame the CLI feeds into run_search_conta. Any
# other loader produces subtly different rates / probabilities.
os.makedirs('/tmp/croc', exist_ok=True)
abundance_path = '/tmp/croc/species_abundance.tsv'
with open(abundance_path, 'w', encoding='utf8') as _f:
    _f.write(abundance_tsv_input)

from crocodeel import ab_table_utils
filter_factor_for_load = (
    float(run_filter_low_ab) if run_filter_low_ab and float(run_filter_low_ab) > 0 else None
)
with open(abundance_path, 'r', encoding='utf8') as _fh:
    ab_df = ab_table_utils.read_filter_normalize(_fh, filter_factor_for_load)
print(f"[load] used crocodeel.ab_table_utils.read_filter_normalize (filter_factor={filter_factor_for_load})")

# Silence tqdm's watchdog-thread warning: Pyodide can't start threads,
# so tqdm fires a TqdmMonitorWarning the first time it instantiates a
# bar. The pipeline runs fine without the watchdog; this just keeps
# the user-facing output panel clean.
import warnings
try:
    from tqdm import tqdm as _tqdm_cls
    _tqdm_cls.monitor_interval = 0
except Exception:
    pass
try:
    from tqdm import TqdmMonitorWarning
    warnings.filterwarnings("ignore", category=TqdmMonitorWarning)
except Exception:
    pass

# Filter-low-ab is already applied by read_filter_normalize above.
filter_low_ab_factor = filter_factor_for_load if filter_factor_for_load else 0.0

# Pyodide ships without _multiprocessing — replace multiprocessing.Pool
# inside crocodeel.search_conta with a synchronous shim.
class _SyncPool:
    def __init__(self, processes=None, *args, **kwargs):
        self.processes = processes
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False
    def map(self, func, iterable, chunksize=None):
        return [func(x) for x in iterable]
    def imap(self, func, iterable, chunksize=None):
        for x in iterable:
            yield func(x)
    def imap_unordered(self, func, iterable, chunksize=None):
        return self.imap(func, iterable, chunksize)
    def starmap(self, func, iterable, chunksize=None):
        return [func(*x) for x in iterable]
    def apply(self, func, args=(), kwds=None):
        return func(*args, **(kwds or {}))
    def apply_async(self, func, args=(), kwds=None, callback=None, error_callback=None):
        kwds = kwds or {}
        class _R:
            def __init__(self, value=None, exc=None):
                self._v = value
                self._e = exc
            def get(self, timeout=None):
                if self._e is not None:
                    raise self._e
                return self._v
            def ready(self):
                return True
            def successful(self):
                return self._e is None
            def wait(self, timeout=None):
                pass
        try:
            v = func(*args, **kwds)
            if callback:
                callback(v)
            return _R(v)
        except BaseException as e:
            if error_callback:
                error_callback(e)
            return _R(exc=e)
    def close(self): pass
    def join(self): pass
    def terminate(self): pass

import crocodeel.search_conta as _sc
_sc.Pool = _SyncPool

from crocodeel.search_conta import run_search_conta, Defaults

# Cutoffs come from the page (run_prob_cutoff / run_rate_cutoff are
# set as worker globals before this script executes). They default to
# the documented CroCoDeEL values; the page also surfaces the live
# Defaults via the "version" message so the curator can compare.
def_attrs = {n: getattr(Defaults, n) for n in dir(Defaults) if not n.startswith('_')}
prob_cutoff = float(run_prob_cutoff)
rate_cutoff = float(run_rate_cutoff)

# Walk the crocodeel package to find a *.joblib / *.pkl model.
model_resource = None
for k, v in def_attrs.items():
    if 'model' in k.lower() and isinstance(v, str) and v.endswith(('.joblib', '.pkl')):
        if os.path.exists(v):
            model_resource = v
            break

if model_resource is None:
    pkg_root = files('crocodeel')
    def _walk(root):
        try:
            for entry in root.iterdir():
                if entry.is_file() and entry.name.lower().endswith(('.joblib', '.pkl')):
                    return entry
                if entry.is_dir():
                    found = _walk(entry)
                    if found is not None:
                        return found
        except Exception:
            pass
        return None
    model_resource = _walk(pkg_root)

if model_resource is None:
    raise RuntimeError(
        "Could not locate the CroCoDeEL RF model in the package.\\n"
        f"Defaults attrs: {def_attrs}"
    )

if isinstance(model_resource, str):
    model_fh = open(model_resource, 'rb')
else:
    model_fh = model_resource.open('rb')
try:
    raw_events = run_search_conta(ab_df, None, model_fh, prob_cutoff, rate_cutoff, 1)
finally:
    try:
        model_fh.close()
    except Exception:
        pass

try:
    import importlib.metadata as _md
    _croc_version = _md.version('crocodeel')
except Exception:
    _croc_version = '?'

import datetime as _dt
_now_iso = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds')

try:
    _rf_model_label = str(model_resource)
    _i = _rf_model_label.find('crocodeel/')
    if _i >= 0:
        _rf_model_label = _rf_model_label[_i:]
except Exception:
    _rf_model_label = 'bundled'

# Use the CLI's writer so the column names + serialization (notably
# the canonical "contamination_specific_species" column) match
# exactly. Anything else risks divergence.
from crocodeel.conta_event import ContaminationEventIO

header = (
    f"# crocodeel version: {_croc_version} | "
    f"probability_cutoff: {prob_cutoff} | "
    f"rate_cutoff: {rate_cutoff} | "
    f"filtering_ab_thr_factor: {filter_low_ab_factor if filter_low_ab_factor > 0 else 'None'} | "
    f"rf_model: {_rf_model_label} | "
    f"hostname: in-browser | "
    f"username: in-browser | "
    f"datetime: {_now_iso}\\n"
)

events_path = '/tmp/croc/contamination_events.tsv'
with open(events_path, 'w', encoding='utf8') as _ev_fh:
    ContaminationEventIO.write_tsv(raw_events, _ev_fh)
with open(events_path, 'r', encoding='utf8') as _ev_fh:
    _events_body = _ev_fh.read()
header + _events_body
`;

self.onmessage = async (e) => {
  if (!e.data || e.data.type !== "run") return;
  try {
    const py = await bootPyodide();
    post({ type: "progress", label: "Running CroCoDeEL on your abundance table…" });
    py.globals.set("abundance_tsv_input", e.data.abundance);
    py.globals.set(
      "run_prob_cutoff",
      typeof e.data.probCutoff === "number" ? e.data.probCutoff : 0.5,
    );
    py.globals.set(
      "run_rate_cutoff",
      typeof e.data.rateCutoff === "number" ? e.data.rateCutoff : 0.0,
    );
    py.globals.set(
      "run_filter_low_ab",
      typeof e.data.filterLowAb === "number" ? e.data.filterLowAb : 0,
    );
    const tsv = await py.runPythonAsync(PYTHON_RUNNER);
    post({ type: "done", tsv });
  } catch (err) {
    post({
      type: "error",
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
    });
  }
};
