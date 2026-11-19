export type Card = {
  id: string;
  src: string;
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

export const CARDS_KEY = ['cuotiben-cards'];
