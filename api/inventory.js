import { createApp } from "../service/app.js";
let handler;
export default {
  fetch(request) {
    handler ??= createApp();
    return handler(request);
  },
};
