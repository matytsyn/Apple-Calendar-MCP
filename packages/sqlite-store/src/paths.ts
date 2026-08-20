import { homedir } from "node:os";
import { join } from "node:path";

export const APP_SUPPORT_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "AppleCalendarMCP"
);

export const DEFAULT_DATABASE_PATH = join(APP_SUPPORT_DIR, "state.sqlite");
