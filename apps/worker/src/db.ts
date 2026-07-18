import { createServiceClient, type Db } from "@youni/db";
import { env } from "./env.js";

let client: Db | undefined;

export function db(): Db {
  client ??= createServiceClient({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return client;
}
