import { sum } from "./math.js";
export const routes = [{ path: "/welcome", component: "WelcomePage" }];
export function greeting(name) {
  return "Hello, " + name;
}
export function total(items) {
  return items.reduce((value, item) => sum(value, item.price), 0);
}
