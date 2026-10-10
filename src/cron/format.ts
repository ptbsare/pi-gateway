/**
 * crontab 表达式格式化显示
 */

/** 将 crontab 表达式转换为中文描述 */
export function formatCronDescription(schedule: string, nextRunAtMs?: number): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;

  const [minute, hour, day, month, weekday] = parts;

  const descriptions: string[] = [];

  // 时间描述
  if (hour === "*" && minute === "*") {
    descriptions.push("每分钟");
  } else if (hour === "*") {
    descriptions.push(`每小时的 ${minute} 分`);
  } else if (minute === "*") {
    descriptions.push(`${hour} 点整`);
  } else {
    descriptions.push(`${hour} 点 ${minute} 分`);
  }

  // 日期描述
  if (day !== "*" || month !== "*") {
    const dateDesc = [];
    if (month !== "*") dateDesc.push(`${month}月`);
    if (day !== "*") dateDesc.push(`${day}日`);
    descriptions.push(dateDesc.join(""));
  }

  // 星期描述
  if (weekday !== "*") {
    const weekDays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    if (weekday.includes(",")) {
      const days = weekday.split(",").map((d) => weekDays[Number(d)] ?? d);
      descriptions.push(`星期${days.join("、")}`);
    } else {
      descriptions.push(weekDays[Number(weekday)] ?? `星期${weekday}`);
    }
  }

  // 下次执行时间
  let nextStr = "";
  if (nextRunAtMs) {
    const next = new Date(nextRunAtMs);
    nextStr = `\n下次执行: ${next.toLocaleString("zh-CN", { hour12: false })}`;
  }

  return descriptions.join("，") + nextStr;
}

/** 将时间戳转换为可读时间 */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
