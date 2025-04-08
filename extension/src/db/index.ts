// src/db/db.ts
import type { drizzle } from "drizzle-orm/libsql/node"
import { migrate } from "drizzle-orm/libsql/migrator"
import * as schema from "./schema"
import path from "path"
import fs from "fs"
import * as vscode from "vscode"
import { LibSQLDatabase } from "drizzle-orm/libsql/driver-core"
// import { migrateFilesystemToDatabase } from "./filesystem-to-db"
class DB {
	private static instance: DB | null = null
	private dbPath: string
	private context: vscode.ExtensionContext
	private db:
		| (LibSQLDatabase<typeof schema> & {
				$client: ReturnType<typeof drizzle>["$client"]
		  })
		| null = null

	private constructor(dbPath: string, context: vscode.ExtensionContext) {
		this.dbPath = dbPath
		this.context = context
	}

	public static async init(dbPath: string, context: vscode.ExtensionContext): Promise<DB> {
		if (!DB.instance) {
			// if dbPath starts with / remove it
			dbPath = dbPath.toPosix()
			DB.instance = new DB(dbPath, context)
			// Then actually connect to the DB
			await DB.instance.initializeDB()
		}
		return DB.instance
	}

	public static getInstance() {
		if (!DB.instance || !DB.instance.db) {
			throw new Error("DB not initialized")
		}
		return DB.instance.db!
	}

	public static disconnect(): void {
		if (DB.instance && DB.instance.db) {
			DB.instance.db.$client.close()
			DB.instance = null
		}
	}

	private ensureDBPath() {
		const dir = path.dirname(this.dbPath)
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true })
		}
		if (!fs.existsSync(this.dbPath)) {
			fs.writeFileSync(this.dbPath, "")
			console.log(`Database file created at: ${this.dbPath}`)
		}
	}

	private async initializeDB(): Promise<void> {
		this.ensureDBPath()
		// We load it externally on runtime to load the correct libsql version (arm, x64, etc)
		const { drizzle } = await import("drizzle-orm/libsql/node")
		// Connect to the SQLite database
		this.db = drizzle({
			connection: `file:${this.dbPath}`,
			schema,
		})
		// Run migrations
		await this.runMigrations()
		console.log("Database connection and migrations completed successfully.")
		// Run custom migrations
		await this.runCustomMigrations()
	}

	private async runMigrations() {
		if (!this.db) {
			return
		}
		const migrationsFolder = path.resolve(__dirname, "db", "migrations")
		await migrate(this.db, {
			migrationsFolder,
		})
		console.log("Migrations completed successfully.")
	}

	private async runCustomMigrations(): Promise<void> {
		if (!this.db) {
			return
		}

		console.log("Running custom migrations...")
		// Run filesystem migration
		const tasksPath = path.join(this.context.globalStorageUri.fsPath, "tasks")
		if (fs.existsSync(tasksPath)) {
			// await migrateFilesystemToDatabase(tasksPath, this.context)
		}
	}
}

export default DB
