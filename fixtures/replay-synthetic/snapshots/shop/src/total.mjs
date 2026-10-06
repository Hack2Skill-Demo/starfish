// SYNTHETIC test fixture for the replay harness (src/scoreboard/replay.test.ts). Not a real incident or a real app.
// The planted defect: the loop starts at 1, so the first line item is never charged.
export function orderTotal(items) {
  let total = 0;
  for (let i = 1; i < items.length; i++) {
    total += items[i].price * items[i].qty;
  }
  return total;
}
