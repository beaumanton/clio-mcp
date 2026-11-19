import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

const { mockClioGetAllPages, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGetAllPages: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/clioClient.js", () => ({
  clioGetAllPages: mockClioGetAllPages,
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { registerActivitySummaryTools } from "../activitySummary.js";

const handlers: Record<string, Function> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: Function) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerActivitySummaryTools(fakeServer as any);
});

const NOW = new Date("2026-09-01T12:00:00Z");

const ARGS = { lookback_days: 90, calendar_days_ahead: 90, limit: 100 };

const MATTER_A = { id: 1, display_number: "00001-001", description: "Busy matter", status: "open", client: { id: 9, name: "Acme" } };
const MATTER_B = { id: 2, display_number: "00002-001", description: "Quiet matter", status: "open", client: { id: 8, name: "Beta" } };

/**
 * Wires the six account-wide reads. Tasks and calendar entries are each read
 * twice: once for the count / next entry, and once with updated_since for the
 * activity date. Any other path, activities included, throws.
 */
function mockCollections(opts: {
  matters?: any[];
  notes?: any[];
  calendar?: any[];
  tasks?: any[];
  changedTasks?: any[];
  changedCalendar?: any[];
}) {
  mockClioGetAllPages.mockImplementation(async (path: string, params: Record<string, string> = {}) => {
    const isChangeRead = "updated_since" in params;
    if (path === "/matters.json") return opts.matters ?? [];
    if (path === "/notes.json") return opts.notes ?? [];
    if (path === "/calendar_entries.json") return (isChangeRead ? opts.changedCalendar : opts.calendar) ?? [];
    if (path === "/tasks.json") return (isChangeRead ? opts.changedTasks : opts.tasks) ?? [];
    throw new Error(`unexpected path ${path}`);
  });
}

async function run(args: Record<string, unknown> = {}) {
  const result = await handlers["matter_activity_summary"]({ ...ARGS, ...args }) as any;
  return { result, parsed: JSON.parse(result.content[0].text) };
}

describe("matter_activity_summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("request shape", () => {
    it("reads each collection once account-wide instead of once per matter", async () => {
      // The whole point of this tool: a per-matter loop over a few hundred
      // matters is a thousand-plus requests and walks into the rate limiter.
      mockCollections({ matters: [MATTER_A, MATTER_B] });
      await run();
      expect(mockClioGetAllPages).toHaveBeenCalledTimes(6);
      const paths = mockClioGetAllPages.mock.calls.map((c) => c[0]).sort();
      expect(paths).toEqual([
        "/calendar_entries.json",
        "/calendar_entries.json",
        "/matters.json",
        "/notes.json",
        "/tasks.json",
        "/tasks.json",
      ]);
    });

    it("never reads Clio's activities endpoint (time entries and expenses)", async () => {
      mockCollections({ matters: [MATTER_A, MATTER_B] });
      const { result, parsed } = await run();
      expect(result.isError).toBeUndefined();
      expect(mockClioGetAllPages.mock.calls.some((c) => c[0] === "/activities.json")).toBe(false);
      expect(parsed.matters[0]).not.toHaveProperty("last_time_entry_date");
    });

    it("asks Clio only for open matters", async () => {
      mockCollections({ matters: [MATTER_A] });
      await run();
      const matterCall = mockClioGetAllPages.mock.calls.find((c) => c[0] === "/matters.json")!;
      expect(matterCall[1].status).toBe("open");
    });

    it("bounds notes by the lookback window", async () => {
      mockCollections({ matters: [MATTER_A] });
      await run({ lookback_days: 30 });
      const notes = mockClioGetAllPages.mock.calls.find((c) => c[0] === "/notes.json")!;
      expect(notes[1].created_since).toBe("2026-08-02T12:00:00.000Z");
      expect(notes[1].type).toBe("matter");
    });

    it("reads task and calendar changes inside the lookback window, whatever their status or date", async () => {
      mockCollections({ matters: [MATTER_A] });
      await run({ lookback_days: 30 });
      const changeRead = (path: string) =>
        mockClioGetAllPages.mock.calls.find((c) => c[0] === path && "updated_since" in c[1])!;

      const tasks = changeRead("/tasks.json");
      expect(tasks[1].updated_since).toBe("2026-08-02T12:00:00.000Z");
      // A completed task is still activity, so this read must not filter by status.
      expect(tasks[1]).not.toHaveProperty("status");

      const cal = changeRead("/calendar_entries.json");
      expect(cal[1].updated_since).toBe("2026-08-02T12:00:00.000Z");
      // Wide window: a changed entry can be dated well before or after today.
      expect(Date.parse(cal[1].from)).toBeLessThan(Date.parse("2000-01-01T00:00:00Z"));
      expect(Date.parse(cal[1].to)).toBeGreaterThan(Date.parse("2031-01-01T00:00:00Z"));

      // Timestamps only: no task name or calendar summary is requested.
      for (const read of [tasks, cal]) expect(read[1].fields).toBe("id,created_at,updated_at,matter{id}");
    });

    it("looks forward, not back, for the calendar", async () => {
      mockCollections({ matters: [MATTER_A] });
      await run({ calendar_days_ahead: 14 });
      const cal = mockClioGetAllPages.mock.calls.find((c) => c[0] === "/calendar_entries.json" && !("updated_since" in c[1]))!;
      expect(cal[1].from).toBe("2026-09-01T00:00:00Z");
      expect(cal[1].to).toBe("2026-09-15T23:59:59Z");
    });

    it("filters by practice area when given", async () => {
      mockCollections({ matters: [MATTER_A] });
      await run({ practice_area_id: 7 });
      const matterCall = mockClioGetAllPages.mock.calls.find((c) => c[0] === "/matters.json")!;
      expect(matterCall[1].practice_area_id).toBe("7");
    });
  });

  describe("per-matter rollup", () => {
    it("takes the newest note per matter and measures staleness from it", async () => {
      mockCollections({
        matters: [MATTER_A],
        notes: [
          { id: 1, date: "2026-08-01", matter: { id: 1 } },
          { id: 2, date: "2026-08-20", matter: { id: 1 } },
        ],
      });
      const { parsed } = await run();
      expect(parsed.matters[0].last_note_date).toBe("2026-08-20");
      expect(parsed.matters[0].days_since_last_activity).toBe(12);
    });

    describe("days_since_last_activity", () => {
      const note = { id: 1, date: "2026-08-12", matter: { id: 1 } }; // 20 days before NOW
      const task = { id: 2, created_at: "2026-08-22T12:00:00Z", updated_at: "2026-08-22T12:00:00Z", matter: { id: 1 } }; // 10 days
      const entry = { id: 3, created_at: "2026-08-27T12:00:00Z", updated_at: "2026-08-27T12:00:00Z", matter: { id: 1 } }; // 5 days

      it.each([
        ["the note when it is newest", { notes: [{ ...note, date: "2026-08-30" }], changedTasks: [task], changedCalendar: [entry] }, 2],
        ["the task when it is newest", { notes: [note], changedTasks: [{ ...task, updated_at: "2026-08-31T12:00:00Z" }], changedCalendar: [entry] }, 1],
        ["the calendar entry when it is newest", { notes: [note], changedTasks: [task], changedCalendar: [entry] }, 5],
      ])("uses %s", async (_label, collections, expectedDays) => {
        mockCollections({ matters: [MATTER_A], ...collections });
        const { parsed } = await run();
        expect(parsed.matters[0].days_since_last_activity).toBe(expectedDays);
      });

      it("reports the three dates it chose between", async () => {
        mockCollections({ matters: [MATTER_A], notes: [note], changedTasks: [task], changedCalendar: [entry] });
        const { parsed } = await run();
        expect(parsed.matters[0]).toMatchObject({
          last_note_date: "2026-08-12",
          last_task_update_date: "2026-08-22T12:00:00Z",
          last_calendar_update_date: "2026-08-27T12:00:00Z",
        });
      });

      it("counts a task or calendar change as activity when there is no note at all", async () => {
        mockCollections({ matters: [MATTER_A, MATTER_B], changedTasks: [task], changedCalendar: [{ ...entry, matter: { id: 2 } }] });
        const { parsed } = await run();
        const byId = Object.fromEntries(parsed.matters.map((m: any) => [m.matter_id, m]));
        expect(byId[1].last_note_date).toBeNull();
        expect(byId[1].days_since_last_activity).toBe(10);
        expect(byId[2].days_since_last_activity).toBe(5);
      });

      it("uses updated_at over created_at, so an old task completed recently is recent activity", async () => {
        mockCollections({
          matters: [MATTER_A],
          changedTasks: [{ id: 2, status: "complete", created_at: "2026-03-01T09:00:00Z", updated_at: "2026-08-29T12:00:00Z", matter: { id: 1 } }],
        });
        const { parsed } = await run();
        expect(parsed.matters[0].days_since_last_activity).toBe(3);
        // It is activity, but it is not an open task.
        expect(parsed.matters[0].open_tasks_count).toBe(0);
      });

      it("falls back to created_at when a record carries no updated_at", async () => {
        mockCollections({ matters: [MATTER_A], changedCalendar: [{ id: 3, created_at: "2026-08-25T12:00:00Z", matter: { id: 1 } }] });
        const { parsed } = await run();
        expect(parsed.matters[0].days_since_last_activity).toBe(7);
      });

      it("stays null when none of the three has anything in the window", async () => {
        mockCollections({ matters: [MATTER_A] });
        const { parsed } = await run();
        expect(parsed.matters[0].days_since_last_activity).toBeNull();
        expect(parsed.matters[0].last_task_update_date).toBeNull();
        expect(parsed.matters[0].last_calendar_update_date).toBeNull();
      });

      it("does not leak one matter's task or calendar change into another", async () => {
        mockCollections({ matters: [MATTER_A, MATTER_B], changedTasks: [task], changedCalendar: [entry] });
        const { parsed } = await run();
        const byId = Object.fromEntries(parsed.matters.map((m: any) => [m.matter_id, m]));
        expect(byId[2].days_since_last_activity).toBeNull();
      });
    });

    it("prefers the note's own date over when it was typed up", async () => {
      mockCollections({
        matters: [MATTER_A],
        notes: [{ id: 1, date: "2026-07-01", created_at: "2026-08-30T00:00:00Z", matter: { id: 1 } }],
      });
      const { parsed } = await run();
      expect(parsed.matters[0].last_note_date).toBe("2026-07-01");
    });

    it("falls back to created_at when a note carries no date", async () => {
      mockCollections({
        matters: [MATTER_A],
        notes: [{ id: 1, created_at: "2026-08-30T00:00:00Z", matter: { id: 1 } }],
      });
      const { parsed } = await run();
      expect(parsed.matters[0].last_note_date).toBe("2026-08-30T00:00:00Z");
    });

    it("returns the soonest future calendar entry and ignores past ones", async () => {
      mockCollections({
        matters: [MATTER_A],
        calendar: [
          { id: 1, summary: "Old hearing", start_at: "2026-08-01T09:00:00Z", matter: { id: 1 } },
          { id: 2, summary: "Deposition", start_at: "2026-09-20T09:00:00Z", matter: { id: 1 } },
          { id: 3, summary: "Status conference", start_at: "2026-09-10T09:00:00Z", matter: { id: 1 } },
        ],
      });
      const { parsed } = await run();
      expect(parsed.matters[0].next_calendar_entry).toEqual({
        start_at: "2026-09-10T09:00:00Z",
        summary: "Status conference",
      });
    });

    it("counts only that matter's open tasks", async () => {
      mockCollections({
        matters: [MATTER_A, MATTER_B],
        tasks: [
          { id: 1, matter: { id: 1 } },
          { id: 2, matter: { id: 1 } },
          { id: 3, matter: { id: 2 } },
        ],
      });
      const { parsed } = await run();
      const byId = Object.fromEntries(parsed.matters.map((m: any) => [m.matter_id, m]));
      expect(byId[1].open_tasks_count).toBe(2);
      expect(byId[2].open_tasks_count).toBe(1);
    });

    it("does not leak one matter's activity into another", async () => {
      mockCollections({
        matters: [MATTER_A, MATTER_B],
        notes: [{ id: 1, date: "2026-08-30", matter: { id: 1 } }],
      });
      const { parsed } = await run();
      const byId = Object.fromEntries(parsed.matters.map((m: any) => [m.matter_id, m]));
      expect(byId[1].last_note_date).toBe("2026-08-30");
      expect(byId[2].last_note_date).toBeNull();
    });

    it("ignores records with no matter attached", async () => {
      mockCollections({
        matters: [MATTER_A],
        notes: [{ id: 1, date: "2026-08-30", matter: null }],
      });
      const { parsed } = await run();
      expect(parsed.matters[0].last_note_date).toBeNull();
    });
  });

  describe("staleness", () => {
    it("sorts the quietest matters first", async () => {
      mockCollections({
        matters: [MATTER_A, MATTER_B],
        notes: [
          { id: 1, date: "2026-08-30", matter: { id: 1 } },
          { id: 2, date: "2026-07-01", matter: { id: 2 } },
        ],
      });
      const { parsed } = await run();
      expect(parsed.matters.map((m: any) => m.matter_id)).toEqual([2, 1]);
    });

    it("treats a matter with nothing in the window as the stalest of all", async () => {
      // null is a stronger signal than any number the window can produce, so it
      // must sort above them rather than falling to the bottom as a falsy value.
      mockCollections({
        matters: [MATTER_A, MATTER_B],
        notes: [{ id: 1, date: "2026-06-05", matter: { id: 1 } }],
      });
      const { parsed } = await run();
      expect(parsed.matters[0].matter_id).toBe(2);
      expect(parsed.matters[0].days_since_last_activity).toBeNull();
    });

    it("keeps silent matters when filtering by stale_after_days", async () => {
      mockCollections({
        matters: [MATTER_A, MATTER_B],
        notes: [{ id: 1, date: "2026-08-30", matter: { id: 1 } }],
      });
      const { parsed } = await run({ stale_after_days: 14 });
      expect(parsed.matters).toHaveLength(1);
      expect(parsed.matters[0].matter_id).toBe(2);
      expect(parsed.matched).toBe(1);
    });

    it("caps the returned rows at limit but still reports how many matched", async () => {
      mockCollections({ matters: [MATTER_A, MATTER_B] });
      const { parsed } = await run({ limit: 1 });
      expect(parsed.matters).toHaveLength(1);
      expect(parsed.matched).toBe(2);
      expect(parsed.open_matters_scanned).toBe(2);
    });
  });

  describe("output hygiene", () => {
    it("returns dates and counts only, never note text", async () => {
      mockCollections({
        matters: [MATTER_A],
        notes: [{ id: 1, date: "2026-08-30", detail: "Client disclosed settlement position", matter: { id: 1 } }],
      });
      const { result } = await run();
      expect(result.content[0].text).not.toContain("settlement position");
    });
  });

  describe("audit log and errors", () => {
    it("logs the sweep with its window, not its findings", async () => {
      mockCollections({ matters: [MATTER_A] });
      await run();
      const entry = mockAppendAuditLog.mock.calls[0][0];
      expect(entry).toMatchObject({ tool: "matter_activity_summary", outcome: "success", result_count: 1 });
    });

    it("returns an error result rather than throwing when a read fails", async () => {
      mockClioGetAllPages.mockRejectedValue(new Error("rate limit exceeded"));
      const result = await handlers["matter_activity_summary"](ARGS) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("rate limit exceeded");
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "matter_activity_summary", outcome: "error" })
      );
    });
  });
});

describe("page budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bounds every collection read so the call cannot outlive the client's timeout", async () => {
    mockClioGetAllPages.mockResolvedValue([]);
    await handlers["matter_activity_summary"](ARGS);

    expect(mockClioGetAllPages).toHaveBeenCalledTimes(6);
    for (const call of mockClioGetAllPages.mock.calls) {
      expect(call[2], `${call[0]} was read without a page budget`).toMatchObject({ maxPages: expect.any(Number) });
    }
  });

  it("turns a book too large for the window into advice, not a silent timeout", async () => {
    mockClioGetAllPages.mockRejectedValue(
      new Error("clioGetAllPages: exceeded maxPages (25) fetching /notes.json — refine filters")
    );

    const result = await handlers["matter_activity_summary"](ARGS) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/lookback_days/);
    expect(result.content[0].text).toMatch(/practice_area_id/);
    // Never a partial answer: this tool decides which matters got dropped, so
    // half the notes would produce confidently wrong staleness.
    expect(result.content[0].text).not.toMatch(/partial/i);
  });

  it("passes other failures through unchanged", async () => {
    mockClioGetAllPages.mockRejectedValue(new Error("boom"));
    const result = await handlers["matter_activity_summary"](ARGS) as any;
    expect(result.content[0].text).toBe("Error: boom");
  });
});
