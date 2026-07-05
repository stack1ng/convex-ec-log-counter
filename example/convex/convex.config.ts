import { defineApp } from "convex/server";
import ecLogCounter from "convex-ec-log-counter/convex.config";

const app = defineApp();
app.use(ecLogCounter);

export default app;
