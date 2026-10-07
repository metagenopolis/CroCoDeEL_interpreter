import { describe, it, expect } from "vitest";
import { parseAbundance } from "../src/parsing.js";

/* The line read as an abundance table's header is a data row when its
   cells after the first are numbers — unless its first cell names the
   species column (a title: "species", "OTU ID", "clade_name", …), in which
   case its sample ids are numbers and it is read as the header, as
   CroCoDeEL reads it (tests/b3-ui-leftovers-parsing.test.js). A taxon
   holds title words too ("organism" in s__uncultured_organism), and such a
   row under a header written as a "#" line (biom, MetaPhlAn) was taken for
   the header: the samples were named after its values, with only a
   warning. CroCoDeEL (pandas, comment="#") reads that table the same
   wrong way, so it is refused, naming the line to fix. */

const refused = /^Line \d looks like the header .* but starts with "#"/;

describe("a taxon read as the header line", () => {
  it("is not a title in a biom table with SILVA lineages", () => {
    const text = [
      "# Constructed from biom file",
      "#OTU ID\tS1\tS2\tS3",
      "d__Bacteria;p__Firmicutes;c__Clostridia;o__Lachnospirales;f__Lachnospiraceae;g__uncultured;s__uncultured_organism\t10\t20\t5",
      "d__Bacteria;p__Bacteroidota;c__Bacteroidia\t1\t2\t3",
    ].join("\n");
    expect(() => parseAbundance(text)).toThrow(refused);
  });

  it("is not a title in a MetaPhlAn table whose header is commented out", () => {
    const text = [
      "#mpa_vJun23_CHOCOPhlAnSGB_202403",
      "#clade_name\tS1\tS2",
      "k__Bacteria|p__Firmicutes|c__Clostridia|s__uncultured_organism\t10\t20",
      "k__Bacteria\t90\t80",
    ].join("\n");
    expect(() => parseAbundance(text)).toThrow(refused);
  });

  it("is not a title as a bare name either", () => {
    for (const first of ["uncultured organism", "unclassified Bacteria", "Lachnospiraceae bacterium", "gut metagenome"]) {
      expect(() => parseAbundance(`#OTU ID\tS1\tS2\n${first}\t10\t20\notu2\t30\t40`), first).toThrow(refused);
    }
  });

  it("leaves the usual titles over numeric sample ids read as the header", () => {
    // Meteor, sylph, QIIME 2, biom, mOTUs, MetaPhlAn titles, numeric ids,
    // under a "#" line as wide: read as the header, with a warning.
    for (const title of ["id_msp", "gtdb_classification", "Feature ID", "OTU ID", "consensus_taxonomy", "clade_name", "species_name", "organism"]) {
      const ab = parseAbundance(`#x\tS1\tS2\n${title}\t1001\t1002\nk__Bacteria|s__a\t1\t2\nd__Bacteria;s__b\t3\t4`);
      expect(ab.firstHeader, title).toBe(title);
      expect(ab.samples).toEqual(["1001", "1002"]);
      expect(ab.species).toEqual(["k__Bacteria|s__a", "d__Bacteria;s__b"]);
      expect(ab.warnings).toHaveLength(1);
    }
  });

  it("does not matter without a '#' line above: CroCoDeEL reads that line as the header", () => {
    const ab = parseAbundance("d__Bacteria;s__uncultured_organism\t10\t20\nd__Bacteria;s__b\t1\t2");
    expect(ab.samples).toEqual(["10", "20"]);
    expect(ab.warnings).toEqual([]);
  });
});
