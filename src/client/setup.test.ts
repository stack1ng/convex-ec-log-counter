/// <reference types="vite/client" />

import { componentsGeneric } from "convex/server";
import { test } from "vitest";
import type { ComponentApi } from "../component/_generated/component.js";
import componentSchema from "../component/schema.js";

export { componentSchema };
export const componentModules = import.meta.glob("../component/**/*.ts");
export const modules = import.meta.glob("./**/*.*s");

export const components = componentsGeneric() as unknown as {
  ecLogCounter: ComponentApi;
};

test("setup", () => {});
