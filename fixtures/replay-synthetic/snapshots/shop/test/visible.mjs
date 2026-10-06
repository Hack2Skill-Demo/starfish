// SYNTHETIC test fixture: the target's own (visible) test, run by the case's verifyCommand. It misses the defect.
import { orderTotal } from "../src/total.mjs";

if (orderTotal([]) !== 0) throw new Error("an empty order should total 0");
