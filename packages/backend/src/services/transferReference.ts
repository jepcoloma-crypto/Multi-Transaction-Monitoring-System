// A transfer reference is minted once, when the row is created, and never
// rewritten afterwards: it is what operators quote to each other and what any
// later statement matching would key on.
//
// The year is taken in UTC to match how timestamps are stored. padStart is
// deliberate — unlike a fixed-width numeric format it never truncates, so a
// seven-digit transfer number keeps every digit rather than being cut down to
// a shorter number's reference and colliding with it.
const PREFIX = 'TRF';
const MIN_WIDTH = 6;

export interface MintedTransfer {
  number: number;
  reference: string;
}

export function mintTransferReference(transferNumber: number, at: Date = new Date()): string {
  if (!Number.isSafeInteger(transferNumber) || transferNumber < 1) {
    throw new Error(`cannot mint a reference from transfer number ${transferNumber}`);
  }
  return `${PREFIX}-${at.getUTCFullYear()}-${String(transferNumber).padStart(MIN_WIDTH, '0')}`;
}
