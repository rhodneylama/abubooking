import path from "node:path";
import { openDb } from "../src/lib/db";
import { seed } from "../src/lib/db/seed";

const file = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "abu.db");
seed(openDb(file));
console.log(`Seeded demo data into ${file}`);
