// Storage is not used — all data comes from Supabase via REST API in routes.ts
// This file is kept as a stub to satisfy imports

export interface IStorage {}

export class DatabaseStorage implements IStorage {}

export const storage = new DatabaseStorage();
