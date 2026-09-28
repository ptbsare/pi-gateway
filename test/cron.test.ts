import { describe, it, expect, afterEach } from "vitest";
import { parseCronSchedule, addJob, loadJobs, removeJob, listJobs, getJob, updateJob, startScheduler, stopScheduler } from "../src/cron/scheduler.js";

describe("parseCronSchedule", () => {
  it("无效格式返回 undefined", () => {
    expect(parseCronSchedule("")).toBeUndefined();
    expect(parseCronSchedule("*/5")).toBeUndefined();
    expect(parseCronSchedule("0 9 * * * extra")).toBeUndefined();
  });

  it("解析 */5 * * * *（每 5 分钟）", () => {
    const ms = parseCronSchedule("*/5 * * * *");
    expect(typeof ms).toBe("number");
    expect(ms!).toBeGreaterThan(Date.now());
  });

  it("解析 0 9 * * *（每天 9:00）", () => {
    const ms = parseCronSchedule("0 9 * * *");
    expect(typeof ms).toBe("number");
    // 下次执行应该在下一个 9:00
    const next = new Date(ms!);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it("解析 30 8 * * 1（每周一 8:30）", () => {
    const ms = parseCronSchedule("30 8 * * 1");
    expect(typeof ms).toBe("number");
    const next = new Date(ms!);
    expect(next.getDay()).toBe(1); // 周一
    expect(next.getHours()).toBe(8);
    expect(next.getMinutes()).toBe(30);
  });
});

describe("addJob / listJobs / removeJob", () => {
  afterEach(() => {
    // 清理测试生成的 job 文件
    import("node:fs").then(({ rmSync }) => {
      rmSync("/root/.pi-gateway/cron-jobs.json", { force: true });
    });
  });

  it("添加任务并列出", () => {
    const result = addJob("*/5 * * * *", "测试 prompt", "test-user");
    expect(result).toBeDefined();
    expect(result!.id).toBeTruthy();
    expect(result!.nextRunAt).toBeGreaterThan(Date.now());
    expect(result!.nextRunAt).toBeLessThan(Date.now() + 10 * 60_000); // 最多 10 分钟后

    const jobs = listJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].prompt).toBe("测试 prompt");
    expect(jobs[0].userId).toBe("test-user");
    expect(jobs[0].enabled).toBe(true);

    // 清理
    removeJob(result!.id);
  });

  it("删除任务", () => {
    const result = addJob("0 9 * * *", "daily", "u1");
    expect(removeJob(result!.id)).toBe(true);
    expect(listJobs().length).toBe(0);
  });
});

describe("getJob / updateJob", () => {
  afterEach(() => {
    import("node:fs").then(({ rmSync }) => {
      rmSync("/root/.pi-gateway/cron-jobs.json", { force: true });
    });
  });

  it("查询不存在的任务返回 undefined", () => {
    expect(getJob("nope")).toBeUndefined();
  });

  it("更新 schedule 与 prompt 后重算下次执行时间", () => {
    const created = addJob("0 9 * * *", "旧", "u", undefined, "acct");
    const before = getJob(created!.id)!;
    expect(before.accountId).toBe("acct");
    // getJob 返回引用，updateJob 原地修改，故先留快照再更新
    const beforeSchedule = before.schedule;
    const updated = updateJob(created!.id, { schedule: "*/5 * * * *", prompt: "新" });
    expect(updated).toBeDefined();
    expect(updated!.schedule).toBe("*/5 * * * *");
    expect(updated!.prompt).toBe("新");
    expect(updated!.schedule).not.toBe(beforeSchedule);
    // getJob 反映最新值
    expect(getJob(created!.id)?.prompt).toBe("新");
    removeJob(created!.id);
  });

  it("update 非法 schedule 返回 undefined 且不改动原任务", () => {
    const created = addJob("0 9 * * *", "keep", "u");
    const updated = updateJob(created!.id, { schedule: "not-a-cron" });
    expect(updated).toBeUndefined();
    expect(getJob(created!.id)?.schedule).toBe("0 9 * * *");
    removeJob(created!.id);
  });

  it("update 可暂停/启用任务", () => {
    const created = addJob("0 9 * * *", "p", "u");
    expect(updateJob(created!.id, { enabled: false })?.enabled).toBe(false);
    expect(updateJob(created!.id, { enabled: true })?.enabled).toBe(true);
    removeJob(created!.id);
  });
});
