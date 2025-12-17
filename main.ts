#!/usr/bin/env bun
import { readdir, stat, rm, access } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

// ============================================================================
// 介面定義
// ============================================================================

interface OrphanFile {
  path: string;
  type: "file" | "directory";
  size: number;
  appName: string;
  reason: string;
  confidence: "high" | "medium" | "low";
  category: string;
}

interface CleanupTask {
  name: string;
  description: string;
  paths: string[];
  commands?: string[];
  enabled: boolean;
}

interface ScanResult {
  orphans: OrphanFile[];
  totalSize: number;
  scannedLocations: string[];
}

interface CleanupItem {
  task: CleanupTask;
  paths: string[];
  totalSize: number;
}

// ============================================================================
// ANSI 顏色碼
// ============================================================================

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bgBlue: "\x1b[44m",
};

// ============================================================================
// 工具函數
// ============================================================================

function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes, i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(2)} ${units[i]}`;
}

function expandPath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

function getSize(path: string): number {
  try {
    const r = execSync(`du -sk "${path}" 2>/dev/null`, { encoding: "utf-8" });
    return parseInt(r.split("\t")[0], 10) * 1024;
  } catch { return 0; }
}

function checkSudo(): boolean {
  try {
    execSync("sudo -n true 2>/dev/null", { encoding: "utf-8" });
    return true;
  } catch { return false; }
}

async function requestSudo(): Promise<boolean> {
  console.log(`\n${colors.yellow}⚠️  需要管理員權限以清理系統檔案${colors.reset}`);
  console.log(`${colors.dim}按 y 輸入密碼取得權限，其他鍵以一般權限執行${colors.reset}\n`);

  return new Promise(resolve => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", async (key) => {
      process.stdin.setRawMode(false);
      if (key.toString().toLowerCase() === "y") {
        try {
          execSync("sudo -v", { stdio: "inherit" });
          resolve(true);
        } catch { resolve(false); }
      } else {
        resolve(false);
      }
    });
  });
}

// ============================================================================
// 清理任務配置
// ============================================================================

const CLEANUP_TASKS: CleanupTask[] = [
  // 系統
  { name: "System Cache", description: "系統快取", paths: ["~/Library/Caches/*"], enabled: true },
  { name: "System Logs", description: "系統日誌", paths: ["~/Library/Logs/*", "/Library/Logs/*"], enabled: true },
  { name: "Diagnostic Reports", description: "診斷報告", paths: ["~/Library/Logs/DiagnosticReports/*"], enabled: true },

  // 開發工具
  { name: "JetBrains", description: "JetBrains IDE 快取", paths: ["~/Library/Caches/JetBrains/*", "~/Library/Logs/JetBrains/*"], enabled: true },
  { name: "VSCode", description: "VSCode 快取", paths: ["~/Library/Application Support/Code/Cache/*", "~/Library/Application Support/Code/CachedData/*", "~/Library/Application Support/Code/logs/*"], enabled: true },
  { name: "Xcode", description: "Xcode 快取", paths: ["~/Library/Developer/Xcode/DerivedData/*", "~/Library/Developer/Xcode/Archives/*", "~/Library/Developer/Xcode/iOS Device Logs/*"], enabled: true },
  { name: "iOS Simulators", description: "iOS 模擬器", paths: ["~/Library/Developer/CoreSimulator/Caches/*"], commands: ["xcrun simctl delete unavailable 2>/dev/null"], enabled: true },

  // 瀏覽器
  { name: "Chrome", description: "Chrome 快取", paths: ["~/Library/Caches/Google/Chrome/*", "~/Library/Application Support/Google/Chrome/Default/Service Worker/*"], enabled: true },
  { name: "Safari", description: "Safari 快取", paths: ["~/Library/Caches/com.apple.Safari/*"], enabled: true },
  { name: "Firefox", description: "Firefox 快取", paths: ["~/Library/Caches/Firefox/*"], enabled: true },

  // Adobe
  { name: "Adobe", description: "Adobe 快取", paths: ["~/Library/Caches/Adobe/*", "~/Library/Application Support/Adobe/Common/Media Cache Files/*"], enabled: true },

  // 套件管理
  { name: "npm", description: "npm 快取", paths: ["~/.npm/_cacache/*"], commands: ["npm cache clean --force 2>/dev/null"], enabled: true },
  { name: "yarn", description: "yarn 快取", paths: ["~/Library/Caches/Yarn/*"], enabled: true },
  { name: "pnpm", description: "pnpm 快取", paths: ["~/Library/pnpm/store/*"], enabled: true },
  { name: "Bun", description: "Bun 快取", paths: ["~/.bun/install/cache/*"], enabled: true },
  { name: "Homebrew", description: "Homebrew 快取", paths: ["~/Library/Caches/Homebrew/*"], commands: ["brew cleanup -s 2>/dev/null"], enabled: true },
  { name: "CocoaPods", description: "CocoaPods 快取", paths: ["~/Library/Caches/CocoaPods/*"], enabled: true },
  { name: "Gradle", description: "Gradle 快取", paths: ["~/.gradle/caches/*"], enabled: true },
  { name: "Maven", description: "Maven 快取", paths: ["~/.m2/repository/*"], enabled: true },

  // 語言環境
  { name: "Go", description: "Go 快取", paths: ["~/go/pkg/mod/cache/*"], commands: ["go clean -cache 2>/dev/null"], enabled: true },
  { name: "Rust/Cargo", description: "Rust 快取", paths: ["~/.cargo/registry/cache/*", "~/.cargo/git/db/*"], enabled: true },
  { name: "Python/pip", description: "pip 快取", paths: ["~/Library/Caches/pip/*", "~/.cache/pip/*"], enabled: true },
  { name: "Ruby/gem", description: "gem 快取", paths: ["~/.gem/ruby/*/cache/*"], enabled: true },
  { name: "PHP/Composer", description: "Composer 快取", paths: ["~/.composer/cache/*"], enabled: true },
  { name: "Deno", description: "Deno 快取", paths: ["~/Library/Caches/deno/*", "~/.deno/gen/*"], enabled: true },
  { name: "Flutter", description: "Flutter 快取", paths: ["~/.pub-cache/*", "~/Library/Developer/Flutter/*"], enabled: true },

  // 容器與虛擬化
  { name: "Docker", description: "Docker 快取", paths: ["~/Library/Containers/com.docker.docker/Data/vms/*"], enabled: true },

  // 遊戲
  { name: "Steam", description: "Steam 快取", paths: ["~/Library/Application Support/Steam/appcache/*"], enabled: true },
  { name: "Minecraft", description: "Minecraft 日誌", paths: ["~/Library/Application Support/minecraft/logs/*"], enabled: true },

  // DNS
  { name: "DNS Cache", description: "DNS 快取", paths: [], commands: ["sudo dscacheutil -flushcache 2>/dev/null", "sudo killall -HUP mDNSResponder 2>/dev/null"], enabled: true },
];

// ============================================================================
// 已知 Bundle ID 對應
// ============================================================================

const KNOWN_BUNDLE_MAPPINGS: Record<string, string> = {
  "com.apple": "Apple",
  "com.google": "Google",
  "com.microsoft": "Microsoft",
  "com.adobe": "Adobe",
  "com.jetbrains": "JetBrains",
  "com.github": "GitHub",
  "com.docker": "Docker",
  "com.spotify": "Spotify",
  "com.discord": "Discord",
  "com.slack": "Slack",
  "org.mozilla": "Mozilla",
  "com.brave": "Brave",
  "com.electron": "Electron",
  "io.github": "GitHub",
  "dev.orbstack": "OrbStack",
};

// ============================================================================
// 殘留檔案位置
// ============================================================================

interface ResidualLocation {
  path: string;
  category: string;
  confidenceBase: "high" | "medium" | "low";
}

const RESIDUAL_LOCATIONS: ResidualLocation[] = [
  { path: "~/Library/Application Support", category: "App Support", confidenceBase: "high" },
  { path: "~/Library/Caches", category: "Caches", confidenceBase: "medium" },
  { path: "~/Library/Preferences", category: "Preferences", confidenceBase: "low" },
  { path: "~/Library/Containers", category: "Containers", confidenceBase: "high" },
  { path: "~/Library/Group Containers", category: "Group", confidenceBase: "high" },
  { path: "~/Library/Saved Application State", category: "Saved State", confidenceBase: "medium" },
  { path: "~/Library/HTTPStorages", category: "HTTP Storage", confidenceBase: "medium" },
  { path: "~/Library/WebKit", category: "WebKit", confidenceBase: "medium" },
  { path: "/Library/Application Support", category: "System App", confidenceBase: "high" },
];

// ============================================================================
// 系統應用程式白名單
// ============================================================================

const SYSTEM_PREFIXES = [
  "com.apple.", "apple.", "system.", ".DS_Store", ".localized",
  "MobileSync", "CloudStorage", "IdentityServices",
];

// ============================================================================
// 進度顯示
// ============================================================================

class ProgressDisplay {
  private spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private index = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private message = "";

  start(msg: string): void {
    this.message = msg;
    this.index = 0;
    this.intervalId = setInterval(() => {
      process.stdout.write(`\r${colors.cyan}${this.spinner[this.index]}${colors.reset} ${this.message}`);
      this.index = (this.index + 1) % this.spinner.length;
    }, 80);
  }

  update(msg: string): void {
    this.message = msg;
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    process.stdout.write("\r" + " ".repeat(100) + "\r");
  }
}

// ============================================================================
// 通用互動式選單（標記刪除）
// ============================================================================

interface SelectableItem {
  name: string;
  path: string;
  size: number;
  detail?: string;
  confidence?: "high" | "medium" | "low";
  category?: string;
}

class InteractiveSelector {
  private items: SelectableItem[];
  private selectedIndex = 0;
  private deleteQueue: Set<number> = new Set();
  private scrollOffset = 0;
  private filterConfidence: "all" | "high" | "medium" | "low" = "all";
  private title: string;
  private hasSudo: boolean;

  constructor(items: SelectableItem[], title: string, hasSudo: boolean) {
    this.items = items;
    this.title = title;
    this.hasSudo = hasSudo;
  }

  private get filteredItems(): SelectableItem[] {
    if (this.filterConfidence === "all") return this.items;
    return this.items.filter(o => o.confidence === this.filterConfidence);
  }

  private clearScreen(): void { process.stdout.write("\x1b[2J\x1b[H"); }
  private hideCursor(): void { process.stdout.write("\x1b[?25l"); }
  private showCursor(): void { process.stdout.write("\x1b[?25h"); }

  private getConfidenceIcon(c?: string): string {
    return c === "high" ? "🔴" : c === "medium" ? "🟡" : c === "low" ? "⚪" : "📦";
  }

  private getConfidenceColor(c?: string): string {
    return c === "high" ? colors.red : c === "medium" ? colors.yellow : colors.dim;
  }

  private render(): void {
    this.clearScreen();
    const filtered = this.filteredItems;
    const markedSize = Array.from(this.deleteQueue).reduce((sum, i) => sum + this.items[i].size, 0);

    console.log("═".repeat(80));
    console.log(`${colors.bright}${colors.cyan}  ${this.title}${colors.reset}`);
    console.log("═".repeat(80));
    console.log(`\n  ${colors.dim}↑/↓ 選擇 | 空白鍵 標記 | a 全選 | Enter 確認刪除 | q 退出${colors.reset}`);

    if (this.items.some(i => i.confidence)) {
      console.log(`  ${colors.dim}1 高信心 | 2 中信心 | 3 低信心 | 0 全部${colors.reset}`);
    }

    const filterText = this.filterConfidence === "all" ? "全部" :
      this.filterConfidence === "high" ? "🔴高" : this.filterConfidence === "medium" ? "🟡中" : "⚪低";
    console.log(`\n  已標記: ${colors.yellow}${this.deleteQueue.size}${colors.reset} | 大小: ${colors.yellow}${formatSize(markedSize)}${colors.reset} | 篩選: ${filterText}`);
    console.log("\n" + "─".repeat(80));

    const maxVisible = 12;
    if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
    else if (this.selectedIndex >= this.scrollOffset + maxVisible) this.scrollOffset = this.selectedIndex - maxVisible + 1;

    const start = this.scrollOffset;
    const end = Math.min(filtered.length, start + maxVisible);

    if (filtered.length === 0) {
      console.log(`\n  ${colors.dim}沒有符合條件的項目${colors.reset}`);
    }

    for (let i = start; i < end; i++) {
      const item = filtered[i];
      const realIdx = this.items.indexOf(item);
      const isSelected = i === this.selectedIndex;
      const isMarked = this.deleteQueue.has(realIdx);

      const marker = isMarked ? `${colors.red}[✗]${colors.reset}` : "[ ]";
      const cursor = isSelected ? `${colors.cyan}▶${colors.reset}` : " ";
      const icon = this.getConfidenceIcon(item.confidence);
      const colorFn = this.getConfidenceColor(item.confidence);
      const name = item.name.substring(0, 20).padEnd(20);
      const cat = (item.category || "").substring(0, 10).padEnd(10);
      const line = ` ${cursor} ${marker} ${icon} ${colorFn}${name}${colors.reset} ${colors.dim}${cat}${colors.reset} ${colors.yellow}${formatSize(item.size).padStart(10)}${colors.reset}`;

      console.log(isSelected ? `${colors.bgBlue}${line}${colors.reset}` : line);
    }

    if (filtered.length > maxVisible) {
      const pct = Math.round((this.scrollOffset / Math.max(1, filtered.length - maxVisible)) * 100);
      console.log(`\n  ${colors.dim}▲▼ ${pct}%${colors.reset}`);
    }

    // 詳細資訊
    console.log("\n" + "─".repeat(80));
    const sel = filtered[this.selectedIndex];
    if (sel) {
      console.log(`\n${colors.bright}${sel.name}${colors.reset}`);
      console.log(`  路徑: ${colors.cyan}${sel.path}${colors.reset}`);
      console.log(`  大小: ${colors.yellow}${formatSize(sel.size)}${colors.reset}`);
      if (sel.detail) console.log(`  ${colors.dim}${sel.detail}${colors.reset}`);
    }
  }

  private async confirmDelete(): Promise<boolean> {
    if (this.deleteQueue.size === 0) {
      console.log(`\n${colors.yellow}沒有標記要刪除的項目${colors.reset}`);
      await this.waitForKey();
      return false;
    }

    this.clearScreen();
    console.log("═".repeat(80));
    console.log(`${colors.bright}${colors.red}  ⚠️  確認刪除${colors.reset}`);
    console.log("═".repeat(80));

    const items = Array.from(this.deleteQueue).map(i => this.items[i]);
    const totalSize = items.reduce((sum, o) => sum + o.size, 0);

    console.log(`\n即將刪除 ${items.length} 個項目:\n`);
    items.slice(0, 10).forEach(item => {
      console.log(`  ${colors.red}✗${colors.reset} ${item.name}`);
      console.log(`    ${colors.dim}${item.path} (${formatSize(item.size)})${colors.reset}`);
    });
    if (items.length > 10) console.log(`  ${colors.dim}... 還有 ${items.length - 10} 個${colors.reset}`);

    console.log(`\n${colors.yellow}總計: ${formatSize(totalSize)}${colors.reset}`);
    console.log(`\n${colors.red}${colors.bright}⚠️  無法復原！${colors.reset}`);
    if (!this.hasSudo) {
      console.log(`${colors.yellow}⚠️  無管理員權限，系統檔案可能刪除失敗${colors.reset}`);
    }
    console.log(`\n按 ${colors.green}y${colors.reset} 確認，其他鍵取消`);

    return new Promise(resolve => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once("data", (key) => {
        process.stdin.setRawMode(false);
        resolve(key.toString().toLowerCase() === "y");
      });
    });
  }

  private async executeDelete(): Promise<void> {
    const items = Array.from(this.deleteQueue).map(i => this.items[i]);
    console.log(`\n${colors.cyan}正在刪除...${colors.reset}\n`);

    let success = 0, fail = 0, freed = 0;
    for (const item of items) {
      try {
        const isContainer = item.path.includes("/Containers/") || item.path.includes("/Group Containers/");
        const isSystemPath = item.path.startsWith("/Library");

        if (isContainer) {
          // Containers 受 SIP 保護，先嘗試刪除內部可刪除的內容
          const dataPath = `${item.path}/Data`;
          let partialSuccess = false;

          try {
            if (this.hasSudo) {
              execSync(`sudo rm -rf "${dataPath}" 2>/dev/null`, { encoding: "utf-8" });
            } else {
              await rm(dataPath, { recursive: true, force: true });
            }
            partialSuccess = true;
          } catch {}

          // 嘗試刪除整個資料夾
          try {
            if (this.hasSudo) {
              execSync(`sudo rm -rf "${item.path}"`, { encoding: "utf-8" });
            } else {
              await rm(item.path, { recursive: true, force: true });
            }
            console.log(`${colors.green}✓${colors.reset} ${item.path}`);
            success++; freed += item.size;
          } catch {
            if (partialSuccess) {
              console.log(`${colors.yellow}◐${colors.reset} ${item.path} ${colors.dim}(已清空內容，外殼受 SIP 保護)${colors.reset}`);
              success++; freed += item.size;
            } else {
              console.log(`${colors.red}✗${colors.reset} ${item.path} ${colors.dim}(SIP 保護)${colors.reset}`);
              fail++;
            }
          }
        } else if (isSystemPath && this.hasSudo) {
          execSync(`sudo rm -rf "${item.path}"`, { encoding: "utf-8" });
          console.log(`${colors.green}✓${colors.reset} ${item.path}`);
          success++; freed += item.size;
        } else {
          await rm(item.path, { recursive: true, force: true });
          console.log(`${colors.green}✓${colors.reset} ${item.path}`);
          success++; freed += item.size;
        }
      } catch (err) {
        console.log(`${colors.red}✗${colors.reset} ${item.path} - ${(err as Error).message}`);
        fail++;
      }
    }

    console.log(`\n${"─".repeat(40)}`);
    console.log(`${colors.green}成功: ${success}${colors.reset}${fail > 0 ? ` | ${colors.red}失敗: ${fail}${colors.reset}` : ""}`);
    console.log(`${colors.yellow}釋放: ${formatSize(freed)}${colors.reset}`);
    await this.waitForKey();
  }

  private waitForKey(): Promise<void> {
    console.log(`\n${colors.dim}按任意鍵繼續...${colors.reset}`);
    return new Promise(resolve => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once("data", () => { process.stdin.setRawMode(false); resolve(); });
    });
  }

  async start(): Promise<void> {
    if (this.items.length === 0) {
      console.log(`\n${colors.green}沒有發現項目！${colors.reset}`);
      return;
    }

    this.hideCursor();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    this.render();

    return new Promise(resolve => {
      const handleKey = async (key: Buffer) => {
        const k = key.toString();
        const filtered = this.filteredItems;

        if (k === "\x1b" || k === "q" || k === "Q") {
          this.showCursor();
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", handleKey);
          this.clearScreen();
          resolve();
          return;
        }

        if (k === "\x1b[A" || k === "k") {
          this.selectedIndex = Math.max(0, this.selectedIndex - 1);
          this.render();
        } else if (k === "\x1b[B" || k === "j") {
          this.selectedIndex = Math.min(filtered.length - 1, this.selectedIndex + 1);
          this.render();
        } else if (k === " ") {
          const realIdx = this.items.indexOf(filtered[this.selectedIndex]);
          if (realIdx >= 0) {
            this.deleteQueue.has(realIdx) ? this.deleteQueue.delete(realIdx) : this.deleteQueue.add(realIdx);
          }
          this.render();
        } else if (k === "\r" || k === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", handleKey);
          if (await this.confirmDelete()) {
            await this.executeDelete();
            this.showCursor();
            resolve();
            return;
          }
          process.stdin.setRawMode(true);
          process.stdin.on("data", handleKey);
          this.render();
        } else if (k === "a" || k === "A") {
          const allSel = filtered.every(o => this.deleteQueue.has(this.items.indexOf(o)));
          filtered.forEach(o => {
            const idx = this.items.indexOf(o);
            allSel ? this.deleteQueue.delete(idx) : this.deleteQueue.add(idx);
          });
          this.render();
        } else if (k === "1") {
          this.filterConfidence = this.filterConfidence === "high" ? "all" : "high";
          this.selectedIndex = 0; this.scrollOffset = 0;
          this.render();
        } else if (k === "2") {
          this.filterConfidence = this.filterConfidence === "medium" ? "all" : "medium";
          this.selectedIndex = 0; this.scrollOffset = 0;
          this.render();
        } else if (k === "3") {
          this.filterConfidence = this.filterConfidence === "low" ? "all" : "low";
          this.selectedIndex = 0; this.scrollOffset = 0;
          this.render();
        } else if (k === "0") {
          this.filterConfidence = "all";
          this.selectedIndex = 0; this.scrollOffset = 0;
          this.render();
        }
      };

      process.stdin.on("data", handleKey);
    });
  }
}

// ============================================================================
// 快取清理掃描器
// ============================================================================

class CleanupScanner {
  private progress = new ProgressDisplay();

  private async expandGlob(pattern: string): Promise<string[]> {
    const base = expandPath(pattern.replace(/\/\*$/, ""));
    if (!pattern.endsWith("/*")) {
      return await pathExists(base) ? [base] : [];
    }
    try {
      const entries = await readdir(base);
      const result: string[] = [];
      for (const e of entries) {
        const full = join(base, e);
        if (await pathExists(full)) result.push(full);
      }
      return result;
    } catch { return []; }
  }

  async scan(tasks: CleanupTask[]): Promise<CleanupItem[]> {
    console.log(`\n${colors.bright}${colors.cyan}════════════════════════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}  🔍 掃描開發環境快取${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}════════════════════════════════════════════════════════════════════════════════${colors.reset}\n`);

    const items: CleanupItem[] = [];
    const enabled = tasks.filter(t => t.enabled);

    for (const task of enabled) {
      this.progress.start(`掃描 ${task.name}...`);
      const allPaths: string[] = [];
      let totalSize = 0;

      for (const pattern of task.paths) {
        const paths = await this.expandGlob(pattern);
        for (const p of paths) {
          this.progress.update(`掃描 ${task.name}... ${colors.dim}${basename(p)}${colors.reset}`);
          const size = getSize(p);
          if (size > 0) {
            allPaths.push(p);
            totalSize += size;
          }
        }
      }

      this.progress.stop();
      if (totalSize > 0) {
        items.push({ task, paths: allPaths, totalSize });
      }
    }

    return items;
  }
}

// ============================================================================
// 殘留檔案掃描器
// ============================================================================

class OrphanScanner {
  private progress = new ProgressDisplay();
  private installedApps = new Set<string>();
  private orphans: OrphanFile[] = [];
  private scannedLocations: string[] = [];

  private async getInstalledApps(): Promise<void> {
    this.progress.start("載入已安裝應用程式...");

    // Spotlight 搜索
    try {
      const apps = execSync('mdfind "kMDItemKind == \'Application\'" 2>/dev/null', { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
      for (const line of apps.split("\n")) {
        const name = basename(line).replace(/\.app$/, "");
        if (name) this.installedApps.add(name.toLowerCase());
      }
    } catch {}

    // Homebrew
    try {
      const brew = execSync("brew list --cask 2>/dev/null", { encoding: "utf-8" });
      brew.split("\n").forEach(n => n.trim() && this.installedApps.add(n.trim().toLowerCase()));
    } catch {}

    // pkgutil
    try {
      const pkgs = execSync("pkgutil --pkgs 2>/dev/null", { encoding: "utf-8" });
      for (const pkg of pkgs.split("\n")) {
        const parts = pkg.split(".");
        if (parts.length >= 2) {
          const name = parts[parts.length - 1].toLowerCase();
          if (name && name.length > 2) this.installedApps.add(name);
        }
      }
    } catch {}

    this.progress.stop();
    console.log(`${colors.dim}已載入 ${this.installedApps.size} 個已安裝應用程式${colors.reset}`);
  }

  private isSystemItem(name: string): boolean {
    const lower = name.toLowerCase();
    return SYSTEM_PREFIXES.some(p => lower.startsWith(p.toLowerCase()) || lower === p.toLowerCase());
  }

  private extractAppName(name: string): string {
    // Bundle ID 對應
    for (const [prefix, appName] of Object.entries(KNOWN_BUNDLE_MAPPINGS)) {
      if (name.toLowerCase().startsWith(prefix)) return appName;
    }

    // 從 bundle ID 提取
    const parts = name.split(".");
    if (parts.length >= 3) return parts[parts.length - 1];
    return name;
  }

  private isAppInstalled(name: string): boolean {
    const lower = name.toLowerCase();
    const appName = this.extractAppName(name).toLowerCase();

    // 直接匹配
    if (this.installedApps.has(lower) || this.installedApps.has(appName)) return true;

    // UUID 格式的資料夾視為孤立（已解除安裝應用的殘留）
    if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(name)) {
      return false;
    }

    // 從 bundle ID 提取最後一部分進行匹配
    const parts = lower.split(".");
    const lastPart = parts[parts.length - 1];

    // 精確匹配最後一部分（應用名稱）
    if (lastPart.length >= 3 && this.installedApps.has(lastPart)) {
      return true;
    }

    return false;
  }

  private async scanLocation(loc: ResidualLocation): Promise<void> {
    const fullPath = expandPath(loc.path);
    this.scannedLocations.push(fullPath);

    try {
      const entries = await readdir(fullPath);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;

        const entryPath = join(fullPath, entry);

        // 跳過系統項目
        if (this.isSystemItem(entry)) continue;

        // 跳過已安裝應用
        if (this.isAppInstalled(entry)) continue;

        // 計算大小
        const size = getSize(entryPath);
        if (size < 1024) continue; // 忽略 <1KB

        let type: "file" | "directory" = "file";
        try {
          const s = await stat(entryPath);
          type = s.isDirectory() ? "directory" : "file";
        } catch {}

        // 決定信心度
        let confidence = loc.confidenceBase;
        if (size > 100 * 1024 * 1024) confidence = "high"; // >100MB
        else if (loc.category === "Preferences" && size < 10 * 1024) confidence = "low";

        this.orphans.push({
          path: entryPath,
          type,
          size,
          appName: this.extractAppName(entry),
          reason: `在 ${loc.category} 發現，應用程式可能已解除安裝`,
          confidence,
          category: loc.category,
        });
      }
    } catch {}
  }

  async scan(): Promise<ScanResult> {
    console.log(`\n${colors.bright}${colors.cyan}════════════════════════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}  🔍 掃描應用程式殘留檔案${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}════════════════════════════════════════════════════════════════════════════════${colors.reset}\n`);

    await this.getInstalledApps();

    console.log(`\n${colors.cyan}📁 掃描 ${RESIDUAL_LOCATIONS.length} 個位置...${colors.reset}\n`);

    for (const loc of RESIDUAL_LOCATIONS) {
      this.progress.start(`掃描 ${loc.category}... ${colors.dim}${loc.path}${colors.reset}`);
      await this.scanLocation(loc);
      this.progress.stop();
    }

    this.orphans.sort((a, b) => b.size - a.size);
    const totalSize = this.orphans.reduce((sum, o) => sum + o.size, 0);

    return { orphans: this.orphans, totalSize, scannedLocations: this.scannedLocations };
  }

  printReport(result: ScanResult): void {
    console.log("\n" + "═".repeat(80));
    console.log(`${colors.bright}${colors.cyan}  📊 掃描報告${colors.reset}`);
    console.log("═".repeat(80));

    const high = result.orphans.filter(o => o.confidence === "high");
    const medium = result.orphans.filter(o => o.confidence === "medium");
    const low = result.orphans.filter(o => o.confidence === "low");

    console.log(`\n  發現: ${colors.yellow}${result.orphans.length}${colors.reset} 個殘留項目`);
    console.log(`  可清理: ${colors.yellow}${formatSize(result.totalSize)}${colors.reset}`);

    console.log(`\n  ${colors.dim}按信心度:${colors.reset}`);
    console.log(`  ${colors.red}🔴 高: ${high.length} 個 (${formatSize(high.reduce((s, o) => s + o.size, 0))})${colors.reset}`);
    console.log(`  ${colors.yellow}🟡 中: ${medium.length} 個 (${formatSize(medium.reduce((s, o) => s + o.size, 0))})${colors.reset}`);
    console.log(`  ${colors.dim}⚪ 低: ${low.length} 個 (${formatSize(low.reduce((s, o) => s + o.size, 0))})${colors.reset}`);

    if (result.orphans.length === 0) {
      console.log(`\n${colors.green}✓ 未發現殘留檔案！${colors.reset}`);
    }
  }
}

// ============================================================================
// 主選單
// ============================================================================

interface MenuItem {
  id: string;
  label: string;
  description: string;
}

const MENU_ITEMS: MenuItem[] = [
  { id: "1", label: "掃描應用程式殘留檔案", description: "找出已解除安裝應用程式的殘留資料" },
  { id: "2", label: "清理開發環境快取", description: "掃描並清理開發工具的快取" },
  { id: "3", label: "完整清理", description: "先清理快取，再掃描殘留" },
  { id: "q", label: "退出", description: "離開程式" },
];

class MainMenu {
  private selectedIndex = 0;

  private clearScreen(): void { process.stdout.write("\x1b[2J\x1b[H"); }
  private hideCursor(): void { process.stdout.write("\x1b[?25l"); }
  private showCursor(): void { process.stdout.write("\x1b[?25h"); }

  private render(hasSudo: boolean): void {
    this.clearScreen();
    console.log(`${colors.bright}${colors.cyan}════════════════════════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}  🧹 macOS 清理工具 v3.0${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}════════════════════════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`\n  ${colors.dim}使用 ↑/↓ 選擇，Enter 確認${colors.reset}`);
    console.log(`  ${hasSudo ? colors.green + "✓ 管理員權限" : colors.yellow + "⚠ 一般權限"}${colors.reset}\n`);

    for (let i = 0; i < MENU_ITEMS.length; i++) {
      const item = MENU_ITEMS[i];
      const isSelected = i === this.selectedIndex;
      if (isSelected) {
        console.log(`  ${colors.cyan}▶${colors.reset} ${colors.bgBlue}${colors.bright} ${item.label} ${colors.reset}`);
      } else {
        console.log(`    ${colors.dim}${item.label}${colors.reset}`);
      }
    }

    console.log(`\n  ${colors.dim}─────────────────────────────────${colors.reset}`);
    console.log(`  ${colors.yellow}${MENU_ITEMS[this.selectedIndex].description}${colors.reset}`);
  }

  async show(hasSudo: boolean): Promise<string> {
    this.hideCursor();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    this.render(hasSudo);

    return new Promise(resolve => {
      const handleKey = (key: Buffer) => {
        const k = key.toString();

        if (k === "\x1b" && key.length === 1) {
          this.showCursor();
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", handleKey);
          resolve("q");
          return;
        }

        if (k === "\x1b[A" || k === "k") {
          this.selectedIndex = (this.selectedIndex - 1 + MENU_ITEMS.length) % MENU_ITEMS.length;
          this.render(hasSudo);
        } else if (k === "\x1b[B" || k === "j") {
          this.selectedIndex = (this.selectedIndex + 1) % MENU_ITEMS.length;
          this.render(hasSudo);
        } else if (k === "\r" || k === "\n") {
          this.showCursor();
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", handleKey);
          this.clearScreen();
          resolve(MENU_ITEMS[this.selectedIndex].id);
        } else if (k >= "1" && k <= "3") {
          this.showCursor();
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", handleKey);
          this.clearScreen();
          resolve(k);
        } else if (k === "q" || k === "Q") {
          this.showCursor();
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", handleKey);
          resolve("q");
        }
      };

      process.stdin.on("data", handleKey);
    });
  }
}

// ============================================================================
// 主程式
// ============================================================================

async function main() {
  // 檢查 sudo 權限
  let hasSudo = checkSudo();
  if (!hasSudo) {
    hasSudo = await requestSudo();
  }

  const menu = new MainMenu();

  while (true) {
    const choice = await menu.show(hasSudo);

    switch (choice) {
      case "1": {
        const scanner = new OrphanScanner();
        const result = await scanner.scan();
        scanner.printReport(result);

        if (result.orphans.length > 0) {
          console.log(`\n按 ${colors.green}y${colors.reset} 進入清理，其他鍵返回選單`);
          const proceed = await new Promise<boolean>(resolve => {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once("data", key => {
              process.stdin.setRawMode(false);
              resolve(key.toString().toLowerCase() === "y");
            });
          });

          if (proceed) {
            const items: SelectableItem[] = result.orphans.map(o => ({
              name: o.appName,
              path: o.path,
              size: o.size,
              detail: o.reason,
              confidence: o.confidence,
              category: o.category,
            }));
            const selector = new InteractiveSelector(items, "🗑️  殘留檔案清理", hasSudo);
            await selector.start();
          }
        }
        break;
      }

      case "2": {
        const cleanupScanner = new CleanupScanner();
        const items = await cleanupScanner.scan(CLEANUP_TASKS);

        if (items.length === 0) {
          console.log(`\n${colors.green}✓ 沒有發現需要清理的快取！${colors.reset}`);
          console.log(`\n${colors.dim}按任意鍵繼續...${colors.reset}`);
          await new Promise<void>(resolve => {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once("data", () => { process.stdin.setRawMode(false); resolve(); });
          });
        } else {
          const total = items.reduce((s, i) => s + i.totalSize, 0);
          console.log(`\n${colors.yellow}發現 ${items.length} 個可清理項目，共 ${formatSize(total)}${colors.reset}`);
          console.log(`\n按 ${colors.green}y${colors.reset} 進入清理，其他鍵返回選單`);

          const proceed = await new Promise<boolean>(resolve => {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once("data", key => {
              process.stdin.setRawMode(false);
              resolve(key.toString().toLowerCase() === "y");
            });
          });

          if (proceed) {
            const selectItems: SelectableItem[] = items.map(i => ({
              name: i.task.name,
              path: i.paths[0] || "",
              size: i.totalSize,
              detail: `${i.task.description} (${i.paths.length} 個路徑)`,
            }));
            const selector = new InteractiveSelector(selectItems, "🧹 開發環境快取清理", hasSudo);
            await selector.start();
          }
        }
        break;
      }

      case "3": {
        // 先清理快取
        const cleanupScanner = new CleanupScanner();
        const cacheItems = await cleanupScanner.scan(CLEANUP_TASKS);

        if (cacheItems.length > 0) {
          const total = cacheItems.reduce((s, i) => s + i.totalSize, 0);
          console.log(`\n${colors.yellow}發現 ${cacheItems.length} 個快取項目，共 ${formatSize(total)}${colors.reset}`);
          console.log(`\n按 ${colors.green}y${colors.reset} 進入清理，其他鍵跳過`);

          const proceed = await new Promise<boolean>(resolve => {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once("data", key => {
              process.stdin.setRawMode(false);
              resolve(key.toString().toLowerCase() === "y");
            });
          });

          if (proceed) {
            const selectItems: SelectableItem[] = cacheItems.map(i => ({
              name: i.task.name,
              path: i.paths[0] || "",
              size: i.totalSize,
              detail: `${i.task.description} (${i.paths.length} 個路徑)`,
            }));
            const selector = new InteractiveSelector(selectItems, "🧹 開發環境快取清理", hasSudo);
            await selector.start();
          }
        } else {
          console.log(`\n${colors.green}✓ 沒有發現需要清理的快取！${colors.reset}`);
        }

        // 再掃描殘留
        const orphanScanner = new OrphanScanner();
        const result = await orphanScanner.scan();
        orphanScanner.printReport(result);

        if (result.orphans.length > 0) {
          console.log(`\n按 ${colors.green}y${colors.reset} 進入清理，其他鍵返回選單`);
          const proceed = await new Promise<boolean>(resolve => {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once("data", key => {
              process.stdin.setRawMode(false);
              resolve(key.toString().toLowerCase() === "y");
            });
          });

          if (proceed) {
            const items: SelectableItem[] = result.orphans.map(o => ({
              name: o.appName,
              path: o.path,
              size: o.size,
              detail: o.reason,
              confidence: o.confidence,
              category: o.category,
            }));
            const selector = new InteractiveSelector(items, "🗑️  殘留檔案清理", hasSudo);
            await selector.start();
          }
        }
        break;
      }

      case "q":
      case "quit":
      case "exit":
        console.log(`\n${colors.cyan}再見！${colors.reset}\n`);
        process.exit(0);
    }
  }
}

main().catch(console.error);
