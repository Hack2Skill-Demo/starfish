// SYNTHETIC test fixture: the PRIVATE evaluator for the order-total cases. Never shown to the fixer or the reviewer.
import { orderTotal } from "../src/total.mjs";

const got = orderTotal([
  { price: 2, qty: 3 },
  { price: 5, qty: 1 },
]);
if (got !== 11) throw new Error(`expected 11, got ${got}`);
