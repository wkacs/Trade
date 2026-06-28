import { describe, it, expect, vi, beforeEach } from "vitest";
import { pingHeartbeat } from "@/lib/ops/heartbeat";

describe("pingHeartbeat", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("env nélkül nem pingel", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await pingHeartbeat(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ok=true → az URL-t hívja", async () => {
    vi.stubEnv("HEARTBEAT_URL", "https://hc.example/abc");
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal("fetch", fetchMock);
    await pingHeartbeat(true);
    expect(fetchMock).toHaveBeenCalledWith("https://hc.example/abc");
  });

  it("ok=false → az URL/fail-t hívja", async () => {
    vi.stubEnv("HEARTBEAT_URL", "https://hc.example/abc");
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal("fetch", fetchMock);
    await pingHeartbeat(false);
    expect(fetchMock).toHaveBeenCalledWith("https://hc.example/abc/fail");
  });

  it("fetch-hibát elnyel (nem dob)", async () => {
    vi.stubEnv("HEARTBEAT_URL", "https://hc.example/abc");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    await expect(pingHeartbeat(true)).resolves.toBeUndefined();
  });
});
