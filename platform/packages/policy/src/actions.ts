import { z } from "zod";
import { ACTION_POLICY, ACTIONS, type Action, type ActionPolicy } from "./action-list.ts";

export type { Action, ActionPolicy };
// The schema over action-list.ts, for code that parses with zod; the browser imports
// action-list.ts instead.
export { ACTION_POLICY, ACTIONS };

export const ActionSchema = z.enum(ACTIONS);
