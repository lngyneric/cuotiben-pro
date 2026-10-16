export type Card = {
  id: string;
  src: string;
  subject: string;
  tag: string;
  kind: string;
  question: string;
  myAnswer: string;
  answer: string;
  principle: string;
  note: string;
  diagram: string | null;
  mastered: boolean;
  createdAt: string;
};

export type QaOption = { text: string; correct: boolean };

export type Stats = {
  total: number;
  correct: number;
  skipped: number;
  rate: number;
};

export const CARDS_KEY = ['cuotiben-cards'];
export const DUE_KEY = ['cuotiben-due'];
export const STATS_KEY = ['cuotiben-stats'];
