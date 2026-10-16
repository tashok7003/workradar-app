import { ME, TEAM } from "../data/mock";
import type { Person } from "../types";

/**
 * People registry. Starts with the mock team; switching to live GitHub data
 * replaces it with the people found in the connected repositories.
 */
let team: Person[] = TEAM;
let me: Person = ME;
let byId = new Map<string, Person>([...team, me].map((p) => [p.id, p]));

export function setPeople(nextTeam: Person[], nextMe: Person) {
  team = nextTeam;
  me = nextMe;
  byId = new Map<string, Person>([...team, me].map((p) => [p.id, p]));
}

export function teamList(): Person[] { return team; }
export function manager(): Person { return me; }

export function person(id: string | null | undefined): Person | undefined {
  return id ? byId.get(id) : undefined;
}

/** Display name for a person id, or the raw string for people outside the team. */
export function nameOf(id: string | null | undefined): string {
  if (!id) return "Unassigned";
  if (id === "me") return "You";
  return byId.get(id)?.name ?? id;
}

export function firstName(id: string | null | undefined): string {
  if (id === "me") return "you";
  return nameOf(id).split(" ")[0];
}
