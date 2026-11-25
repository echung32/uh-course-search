// Row shapes for UH's public Class Availability ("crseavail") JSON API.
// crseavail omits null-valued fields, so every `| null` field is optional (absent = null).
// Only the fields we consume are declared; responses carry many more.
export interface CaSubjectRow {
  stvtermCode: string;
  stvtermDesc: string;
  ssbsectCampCode: string;
  stvsubjCode: string;
  stvsubjDesc: string;
  countStvtermCode: number;
}

export interface CaCourseRow {
  ssbsectCrn1: string;
  crseNumb: string;
  subjCode: string;
  collCode?: string | null;
  deptCode?: string | null;
  creditHrLow?: number | null;
  creditHrHigh?: number | null; // absent in real responses when the course has no credit range
  lecHrLow?: number | null;
  labHrLow?: number | null;
  othHrLow?: number | null;
  contHrLow?: number | null;
  billHrLow?: number | null;
  repeatLimit?: number | null;
  maxRptUnits?: number | null;
}

export interface CaCourseDescRow {
  ssbsectCrn1: string;
  textNarrative?: string | null;
}

export interface CaGradingRow {
  ssbsectCrn1: string;
  gmodCode: string;
  desc: string;
}

export interface CaCrossListRow {
  ssbsectCrn: string;
  ssbsectCampCode: string;
  ssrxlstXlstGroup: string;
}

/** One (term, campus, subject) fetch unit. */
export interface CaUnit {
  term: string;
  campusCode: string;
  subject: string;
}
