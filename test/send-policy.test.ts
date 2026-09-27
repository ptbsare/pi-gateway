import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkSendPolicy, parseDirList, type SendPolicy } from "../src/send-policy.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

describe("parseDirList", () => {
  it("解析冒号与分号分隔的目录列表，并统一添加尾斜杠", () => {
    const list = parseDirList("/a/b;/c/d:/e/f/");
    expect(list).toContain(resolve("/a/b") + sep);
    expect(list).toContain(resolve("/c/d") + sep);
    expect(list).toContain(resolve("/e/f") + sep);
  });
});

describe("checkSendPolicy 目录黑白名单判定", () => {
  const tmpDir = resolve("./tmp-policy-test");
  const allowDir = join(tmpDir, "allow");
  const denyDir = join(tmpDir, "deny");
  const fileInAllow = join(allowDir, "confidential.txt");
  const fileInDeny = join(denyDir, "confidential.txt");
  const fileOutside = join(tmpDir, "other.txt");

  beforeEach(() => {
    mkdirSync(allowDir, { recursive: true });
    mkdirSync(denyDir, { recursive: true });
    writeFileSync(fileInAllow, "secret content");
    writeFileSync(fileInDeny, "secret content");
    writeFileSync(fileOutside, "some data");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("无规则时一律放行", () => {
    const policy: SendPolicy = { allow: [], deny: [] };
    expect(checkSendPolicy(fileInAllow, policy).allowed).toBe(true);
    expect(checkSendPolicy(fileOutside, policy).allowed).toBe(true);
  });

  it("白名单启用时：仅放行白名单内的文件", () => {
    const policy: SendPolicy = { allow: [allowDir + sep], deny: [] };
    expect(checkSendPolicy(fileInAllow, policy).allowed).toBe(true);
    expect(checkSendPolicy(fileOutside, policy).allowed).toBe(false);
    expect(checkSendPolicy(fileInDeny, policy).allowed).toBe(false);
  });

  it("黑名单启用时：仅拦截黑名单内文件", () => {
    const policy: SendPolicy = { allow: [], deny: [denyDir + sep] };
    expect(checkSendPolicy(fileInAllow, policy).allowed).toBe(true);
    expect(checkSendPolicy(fileOutside, policy).allowed).toBe(true);
    expect(checkSendPolicy(fileInDeny, policy).allowed).toBe(false);
    expect(checkSendPolicy(fileInDeny, policy).reason).toContain("发送黑名单");
  });
});
