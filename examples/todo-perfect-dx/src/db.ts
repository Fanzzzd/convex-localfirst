import { createLocalDb } from "convex-localfirst/react";
import * as comments from "../convex/comments";
import * as docUpdates from "../convex/docUpdates";
import * as documents from "../convex/documents";
import * as issues from "../convex/issues";
import * as labels from "../convex/labels";
import * as projects from "../convex/projects";
import * as todos from "../convex/todos";

export const modules = { todos, issues, projects, comments, labels, documents, docUpdates };
export const db = createLocalDb(modules);
