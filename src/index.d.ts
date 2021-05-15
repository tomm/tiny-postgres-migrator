import * as postgres from "postgres";

export declare function cmd(cmd_name: string | undefined, sql: any, migration_paths: string[], args: string[]): Promise<void>;
export declare function applyMigration(sql: postgres.Sql<any>, migration_loc: string): Promise<void>;
export declare function revertMigration(sql: postgres.Sql<any>, migration_loc: string): Promise<void>;
export declare function applyAllMigrations(sql: postgres.Sql<any>, paths: string[]): Promise<void>;
export declare function createMigration(name: string, directory: string): Promise<void>;
