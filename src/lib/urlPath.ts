import { z } from "zod";

const URL_PATH_RULE = "must start with '/' and contain only letters, numbers, '/', '-', '_' or '.'";

/** A URL path such as /login or /api/v1/orders: no query, no spaces, no '..' segments. */
export const urlPathSchema = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9/_.-]*$/, URL_PATH_RULE)
  .refine((value) => !value.split("/").includes(".."), "must not contain '..' segments");
