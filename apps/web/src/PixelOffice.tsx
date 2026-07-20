// 像素办公室：Canvas 手绘的温馨像素风楼层。
// 奶油墙面 + 阳光窗户 + 木地板 + 地毯 + 沙发休息区 + 咖啡角 + 橘猫；
// 每位成员一个小人：busy 坐工位敲键盘、online 在楼层里溜达、offline 去休息区打盹；
// 说话冒气泡；点小人可上传/生成/清除人物形象（库洛米、皮卡丘随便换）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentCard, AgentMeta } from "@agent-office/protocol";
import { api, type OfficeState } from "./api";

/** 楼层逻辑坐标系：0-100 × 0-100（渲染时按容器等比缩放） */
interface Actor {
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** 下次换目标的时间戳（休闲漫步节奏） */
  nextWanderAt: number;
  facing: 1 | -1;
}

interface Bubble {
  agentName: string;
  text: string;
  until: number;
}

const REST_Y = 84; // 休息区（楼层底部沙发一带）
const SPEED = 6; // 每秒移动的逻辑单位

/** 场景画布的内部分辨率（CSS 拉伸 + pixelated 得到像素颗粒感） */
const CW = 480;
const CH = 270;

/** 工位坐标：三列桌子，错落排布（百分比） */
function deskSlot(index: number): { x: number; y: number } {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return { x: 20 + col * 28, y: 24 + row * 24 };
}

function hashHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// ---------- 默认像素小人（SVG 逐像素） ----------

const SPRITE_ROWS = [
  "....hhhh....",
  "...hhhhhh...",
  "..hhhhhhhh..",
  "..hssssssh..",
  "..sesssses..",
  "..srssssrs..",
  "...ssssss...",
  "..bbbbbbbb..",
  ".sbbbbbbbbs.",
  ".sbbbbbbbbs.",
  "..bbbbbbbb..",
  "..pp....pp..",
  "..pp....pp..",
  "..ff....ff..",
];

function DefaultSprite({ name }: { name: string }) {
  const hue = hashHue(name);
  const colors: Record<string, string> = {
    h: `hsl(${hue}, 48%, 32%)`,
    s: "#f6cfa4",
    e: "#2f2a33",
    r: "#f0a08a",
    b: `hsl(${hue}, 58%, 52%)`,
    p: "#3a4160",
    f: "#7a4c2e",
  };
  return (
    <svg className="px-default" viewBox="0 0 12 14" shapeRendering="crispEdges" aria-hidden>
      {SPRITE_ROWS.flatMap((row, y) =>
        [...row].map((c, x) =>
          c === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={colors[c]} />,
        ),
      )}
    </svg>
  );
}

// ---------- 温馨办公室场景（Canvas 手绘） ----------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawScene(ctx: CanvasRenderingContext2D, deskCount: number) {
  const rnd = mulberry32(20260720);
  const P = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };
  /** 圆角矩形（阶梯式圆角，保持像素味） */
  const R = (x: number, y: number, w: number, h: number, c: string) => {
    P(x + 4, y, w - 8, h, c);
    P(x + 2, y + 1, w - 4, h - 2, c);
    P(x, y + 3, w, h - 6, c);
  };

  ctx.clearRect(0, 0, CW, CH);

  // ----- 墙面 -----
  const WALL_H = 40;
  P(0, 0, CW, WALL_H, "#efdcb8");
  P(0, 0, CW, 3, "#e2c99b");
  for (let x = 0; x < CW; x += 24) P(x, 4, 1, WALL_H - 8, "rgba(120,90,50,0.06)");
  P(0, WALL_H - 6, CW, 4, "#caa06b"); // 墙裙压条
  P(0, WALL_H - 2, CW, 2, "#8a6544"); // 踢脚线

  // ----- 窗户（三扇，蓝天 + 云 + 太阳） -----
  const wins = [64, 208, 352];
  wins.forEach((wx, wi) => {
    const ww = 64;
    const wh = 28;
    const wy = 4;
    P(wx - 2, wy - 2, ww + 4, wh + 4, "#8a6a48"); // 外框
    P(wx, wy, ww, wh, "#aadff2"); // 天空
    P(wx, wy + wh - 9, ww, 5, "#c4ecf8");
    P(wx, wy + wh - 4, ww, 4, "#d9f4fb");
    if (wi === 0) {
      P(wx + 44, wy + 4, 8, 8, "#ffd95e"); // 太阳
      P(wx + 46, wy + 2, 4, 12, "#ffd95e");
      P(wx + 42, wy + 6, 12, 4, "#ffd95e");
    }
    P(wx + 8 + wi * 4, wy + 7, 14, 3, "#ffffff"); // 云
    P(wx + 11 + wi * 4, wy + 5, 8, 3, "#ffffff");
    P(wx + ww / 2 - 1, wy, 2, wh, "#8a6a48"); // 十字窗棂
    P(wx, wy + wh / 2 - 1, ww, 2, "#8a6a48");
    P(wx - 4, wy + wh + 2, ww + 8, 3, "#a5794f"); // 窗台
  });

  // ----- 墙面装饰：挂画 / 挂钟 / 吊兰 -----
  P(24, 8, 22, 18, "#8a6a48");
  P(26, 10, 18, 14, "#f6ead0");
  P(28, 16, 6, 6, "#7fae72"); // 画里的小山
  P(33, 14, 8, 8, "#5e8e6b");
  P(36, 12, 4, 4, "#ffd95e");
  // 挂钟
  P(160, 8, 16, 16, "#8a6a48");
  P(162, 10, 12, 12, "#fdf6e5");
  P(167, 12, 2, 5, "#3a2c1c");
  P(167, 16, 5, 2, "#3a2c1c");
  // 书架（墙挂）
  P(298, 10, 44, 4, "#8a6a48");
  const bookColors = ["#c76a52", "#7fae72", "#6a8fc9", "#e0b357", "#a377b8"];
  for (let i = 0; i < 9; i += 1) {
    P(300 + i * 4.4, 10 - 8 + (i % 3 === 0 ? 1 : 0), 3, 8 - (i % 3 === 0 ? 1 : 0), bookColors[i % bookColors.length]);
  }
  // 吊兰
  P(440, 4, 12, 7, "#b5563f");
  P(442, 2, 8, 3, "#8f4231");
  for (let i = 0; i < 6; i += 1) {
    P(438 + i * 3, 10 + (i % 2) * 3, 2, 8 + (i % 3) * 3, i % 2 ? "#4f9b55" : "#3d7f44");
  }

  // ----- 木地板 -----
  for (let y = WALL_H; y < CH; y += 12) {
    const row = (y - WALL_H) / 12;
    for (let x = -24 + (row % 2) * 24; x < CW; x += 48) {
      const tone = rnd();
      P(x, y, 48, 12, tone < 0.33 ? "#cf9c63" : tone < 0.66 ? "#c8945a" : "#d4a46c");
      P(x, y, 48, 1, "#b98a52");
      P(x + 47, y, 1, 12, "#b98a52");
    }
  }
  // 木纹小结疤
  for (let i = 0; i < 34; i += 1) {
    P(8 + rnd() * (CW - 16), WALL_H + 4 + rnd() * (CH - WALL_H - 10), 2, 1, "rgba(140,95,50,0.5)");
  }

  // ----- 中央地毯 -----
  R(104, 78, 268, 128, "#87b7a4");
  R(110, 83, 256, 118, "#f2e6c9");
  R(116, 88, 244, 108, "#79a893");
  // 地毯菱形纹样
  for (let i = 0; i < 5; i += 1) {
    const dx = 148 + i * 46;
    P(dx, 138, 8, 8, "#f2e6c9");
    P(dx + 2, 136, 4, 12, "#f2e6c9");
    P(dx - 2, 140, 12, 4, "#f2e6c9");
  }

  // ----- 阳光洒进来（窗下光斑） -----
  ctx.globalAlpha = 0.1;
  wins.forEach((wx) => {
    ctx.fillStyle = "#ffd98f";
    ctx.beginPath();
    ctx.moveTo(wx + 4, WALL_H);
    ctx.lineTo(wx + 60, WALL_H);
    ctx.lineTo(wx + 76, 150);
    ctx.lineTo(wx - 12, 150);
    ctx.closePath();
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  // ----- 休息区：沙发 + 落地灯 + 小茶几 -----
  // 落地灯（暖光）
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = "#ffd98f";
  ctx.beginPath();
  ctx.arc(24, 226, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  P(22, 214, 3, 30, "#6f4a2c");
  P(14, 204, 19, 11, "#e8b45f");
  P(16, 202, 15, 3, "#d19c48");
  // 沙发
  P(40, 224, 84, 9, "#a5573f"); // 靠背
  P(36, 230, 6, 22, "#8f4a36"); // 左扶手
  P(122, 230, 6, 22, "#8f4a36"); // 右扶手
  P(42, 232, 39, 14, "#c76a52"); // 坐垫
  P(83, 232, 39, 14, "#c76a52");
  P(42, 244, 80, 6, "#a5573f"); // 座框
  P(44, 250, 4, 4, "#5a3a24");
  P(116, 250, 4, 4, "#5a3a24");
  P(52, 228, 12, 8, "#e0b357"); // 抱枕
  P(100, 228, 12, 8, "#7fae72");
  // 小茶几
  P(140, 238, 30, 4, "#9a6a3f");
  P(142, 242, 3, 10, "#7a5230");
  P(165, 242, 3, 10, "#7a5230");
  P(148, 232, 6, 6, "#f6ead0"); // 茶杯
  P(154, 234, 2, 3, "#f6ead0");

  // ----- 咖啡角（右下） -----
  P(388, 228, 76, 6, "#a5714a"); // 台面
  P(390, 234, 72, 20, "#8a5a35"); // 柜体
  P(396, 240, 12, 10, "#6f4a2c"); // 柜门
  P(414, 240, 12, 10, "#6f4a2c");
  P(432, 240, 12, 10, "#6f4a2c");
  // 咖啡机
  P(398, 210, 20, 18, "#3c4254");
  P(400, 212, 16, 5, "#2b303d");
  P(404, 222, 8, 6, "#f6ead0"); // 咖啡杯
  P(414, 214, 3, 3, "#e05744"); // 指示灯
  // 蒸汽
  P(407, 204, 2, 4, "rgba(255,255,255,0.7)");
  P(409, 200, 2, 4, "rgba(255,255,255,0.5)");
  // 果篮 + 水壶
  P(428, 220, 14, 8, "#b5824e");
  P(430, 217, 4, 4, "#e05744");
  P(435, 217, 4, 4, "#7fae72");
  P(448, 214, 10, 14, "#6a8fc9");
  P(450, 210, 6, 5, "#5a7ab2");

  // ----- 角落绿植 -----
  const plant = (cx: number, cy: number, big: boolean) => {
    const s = big ? 1.4 : 1;
    P(cx - 5 * s, cy, 10 * s, 3 * s, "#8f4231");
    P(cx - 4 * s, cy + 3 * s, 8 * s, 6 * s, "#b5563f");
    P(cx - 7 * s, cy - 10 * s, 5 * s, 9 * s, "#3d7f44");
    P(cx + 1 * s, cy - 12 * s, 5 * s, 11 * s, "#4f9b55");
    P(cx - 3 * s, cy - 15 * s, 5 * s, 14 * s, "#356e3c");
    P(cx - 1 * s, cy - 8 * s, 3 * s, 8 * s, "#5cab63");
  };
  plant(14, 58, false);
  plant(464, 58, false);
  plant(464, 236, true);

  // ----- 打盹的橘猫（地毯边） -----
  const catX = 244;
  const catY = 208;
  P(catX - 8, catY - 2, 18, 8, "#e8a052"); // 蜷成一团的身子
  P(catX - 6, catY - 5, 14, 4, "#e8a052");
  P(catX - 10, catY - 7, 8, 7, "#e8a052"); // 头
  P(catX - 10, catY - 9, 2, 3, "#d18a3e"); // 耳朵
  P(catX - 5, catY - 9, 2, 3, "#d18a3e");
  P(catX - 9, catY - 4, 2, 1, "#3a2c1c"); // 眯眼
  P(catX - 5, catY - 4, 2, 1, "#3a2c1c");
  P(catX + 8, catY - 4, 3, 8, "#d18a3e"); // 卷尾巴
  P(catX + 6, catY + 2, 5, 3, "#d18a3e");
  P(catX - 4, catY + 1, 6, 2, "#f6d7ab"); // 白肚皮

  // ----- 工位桌（按成员数量摆，最少 6 张，办公室不冷清） -----
  const desks = Math.max(deskCount, 6);
  for (let i = 0; i < desks; i += 1) {
    const slot = deskSlot(i);
    const cx = (slot.x / 100) * CW;
    const cy = ((slot.y + 5) / 100) * CH;
    // 椅子影子（成员站的位置）
    // 桌腿
    P(cx - 16, cy + 5, 3, 9, "#7a5230");
    P(cx + 13, cy + 5, 3, 9, "#7a5230");
    // 桌面
    P(cx - 18, cy - 2, 36, 3, "#c98f58");
    P(cx - 18, cy + 1, 36, 6, "#b07845");
    P(cx - 18, cy + 5, 36, 2, "#8a5a35");
    // 显示器
    P(cx - 8, cy - 16, 16, 12, "#3b4252");
    P(cx - 7, cy - 15, 14, 10, "#20345c");
    P(cx - 5, cy - 13, 5, 2, "#4d7ab8");
    P(cx - 5, cy - 10, 9, 1, "#3c5e93");
    P(cx - 1, cy - 4, 2, 2, "#2b303d"); // 支架
    // 键盘 + 马克杯
    P(cx - 5, cy - 1, 12, 3, "#454e61");
    P(cx + 10, cy - 4, 5, 5, i % 2 ? "#c9564a" : "#6a8fc9");
    P(cx + 15, cy - 3, 2, 2, i % 2 ? "#c9564a" : "#6a8fc9");
    // 桌角小物：绿植或书堆
    if (i % 2 === 0) {
      P(cx - 16, cy - 6, 5, 4, "#b5563f");
      P(cx - 15, cy - 10, 3, 4, "#4f9b55");
      P(cx - 17, cy - 9, 3, 3, "#3d7f44");
    } else {
      P(cx - 17, cy - 4, 8, 2, "#c76a52");
      P(cx - 16, cy - 6, 8, 2, "#6a8fc9");
      P(cx - 17, cy - 8, 8, 2, "#e0b357");
    }
  }

  // ----- 氛围光：顶部暖光 + 底部微暗 -----
  const grad = ctx.createLinearGradient(0, 0, 0, CH);
  grad.addColorStop(0, "rgba(255,214,150,0.10)");
  grad.addColorStop(0.5, "rgba(255,214,150,0)");
  grad.addColorStop(1, "rgba(60,40,20,0.10)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CW, CH);
}

function statusOf(agent: AgentCard): "busy" | "online" | "offline" {
  return agent.status === "busy" ? "busy" : agent.status === "offline" ? "offline" : "online";
}

export function PixelOffice({
  state,
  onChanged,
}: {
  state: OfficeState;
  onChanged: () => void;
}) {
  const floorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const actorsRef = useRef(new Map<string, Actor>());
  const nodesRef = useRef(new Map<string, HTMLDivElement>());
  const [selected, setSelected] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [busyAction, setBusyAction] = useState(false);
  const [error, setError] = useState("");
  const [genPrompt, setGenPrompt] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const crew = useMemo(
    () => state.agents.filter((a) => a.kind !== "user"),
    [state.agents],
  );
  const deskAgents = useMemo(() => crew.filter((a) => a.kind !== "supervisor"), [crew]);

  // 场景绘制（成员数量变化时重画，PRNG 固定种子不会闪烁）
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) drawScene(ctx, deskAgents.length);
  }, [deskAgents.length]);

  // 新消息/简报 → 冒 8 秒气泡
  const lastSeenRef = useRef<number>(Date.now());
  useEffect(() => {
    const fresh: Bubble[] = [];
    for (const m of state.messages) {
      if (m.createdAt > lastSeenRef.current && crew.some((a) => a.name === m.fromName)) {
        fresh.push({ agentName: m.fromName, text: m.text, until: Date.now() + 8000 });
      }
    }
    for (const b of state.briefs) {
      if (b.createdAt > lastSeenRef.current && crew.some((a) => a.name === b.agentName)) {
        fresh.push({ agentName: b.agentName, text: b.title, until: Date.now() + 8000 });
      }
    }
    if (fresh.length > 0) {
      lastSeenRef.current = Date.now();
      setBubbles((prev) => [...prev.filter((x) => x.until > Date.now()), ...fresh].slice(-12));
    }
  }, [state.messages, state.briefs, crew]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setBubbles((prev) => (prev.some((b) => b.until <= Date.now()) ? prev.filter((b) => b.until > Date.now()) : prev));
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  // 游戏循环：目标点驱动的走路 + 直接改 DOM（不经 React 渲染）
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      deskAgents.forEach((agent, i) => {
        const desk = deskSlot(i);
        let actor = actorsRef.current.get(agent.id);
        if (!actor) {
          actor = { x: desk.x, y: desk.y, tx: desk.x, ty: desk.y, nextWanderAt: 0, facing: 1 };
          actorsRef.current.set(agent.id, actor);
        }
        const st = statusOf(agent);
        if (st === "busy") {
          // 回工位干活
          actor.tx = desk.x;
          actor.ty = desk.y;
        } else if (st === "offline") {
          // 去休息区打盹（沙发一带排开）
          actor.tx = 14 + (i % 6) * 13;
          actor.ty = REST_Y;
        } else if (now >= actor.nextWanderAt) {
          // 在楼层里随便走走（避开休息区）
          actor.tx = 10 + Math.random() * 80;
          actor.ty = 18 + Math.random() * 52;
          actor.nextWanderAt = now + 3000 + Math.random() * 6000;
        }
        const dx = actor.tx - actor.x;
        const dy = actor.ty - actor.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.5) {
          const step = Math.min(SPEED * dt, dist);
          actor.x += (dx / dist) * step;
          actor.y += (dy / dist) * step;
          if (Math.abs(dx) > 0.3) actor.facing = dx > 0 ? 1 : -1;
        }
        const node = nodesRef.current.get(agent.id);
        if (node) {
          node.style.left = `${actor.x}%`;
          node.style.top = `${actor.y}%`;
          const walking = dist > 0.5 && st !== "busy";
          node.dataset.state = st === "busy" ? "typing" : walking ? "walking" : st === "offline" ? "sleeping" : "idle";
          node.dataset.facing = String(actor.facing);
        }
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deskAgents]);

  const selectedAgent = crew.find((a) => a.id === selected) ?? null;

  const uploadSprite = useCallback(
    async (file: File) => {
      if (!selectedAgent) return;
      setBusyAction(true);
      setError("");
      try {
        const { url } = await api.uploadImage(file);
        await api.updateAgent(selectedAgent.id, { spriteUrl: url });
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyAction(false);
      }
    },
    [selectedAgent, onChanged],
  );

  const generateSprite = useCallback(async () => {
    if (!selectedAgent) return;
    const desc = genPrompt.trim() || "可爱的像素风小人";
    setBusyAction(true);
    setError("");
    try {
      await api.generateAvatar(selectedAgent.id, `像素画风格（pixel art），${desc}`);
      // 生成的是 avatarSvg；若之前有上传形象则清掉，让新生成的生效
      if ((selectedAgent.meta as AgentMeta).spriteUrl) {
        await api.updateAgent(selectedAgent.id, { spriteUrl: "" });
      }
      setGenPrompt("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(false);
    }
  }, [selectedAgent, genPrompt, onChanged]);

  const clearSprite = useCallback(async () => {
    if (!selectedAgent) return;
    setBusyAction(true);
    setError("");
    try {
      await api.updateAgent(selectedAgent.id, { spriteUrl: "" });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(false);
    }
  }, [selectedAgent, onChanged]);

  return (
    <div className="pixel-office">
      <div className="pixel-floor" ref={floorRef} onClick={() => setSelected(null)}>
        <canvas ref={canvasRef} className="px-canvas" width={CW} height={CH} aria-hidden />

        {/* 成员小人 */}
        {deskAgents.map((agent) => {
          const m = agent.meta as AgentMeta;
          const bubble = bubbles.filter((b) => b.agentName === agent.name).at(-1);
          return (
            <div
              key={agent.id}
              ref={(el) => {
                if (el) nodesRef.current.set(agent.id, el);
                else nodesRef.current.delete(agent.id);
              }}
              className={`px-actor st-${statusOf(agent)} ${selected === agent.id ? "selected" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setSelected(agent.id);
                setError("");
              }}
              title={`${agent.name} · ${agent.status}${m.title ? ` · ${m.title}` : ""}`}
            >
              {bubble && <div className="px-bubble">{bubble.text.slice(0, 60)}</div>}
              <div className="px-sprite">
                {m.spriteUrl ? (
                  <img src={m.spriteUrl} alt={agent.name} draggable={false} />
                ) : m.avatarSvg ? (
                  <span
                    className="px-svg"
                    dangerouslySetInnerHTML={{ __html: m.avatarSvg }}
                  />
                ) : (
                  <DefaultSprite name={agent.name} />
                )}
                <span className="px-status-dot" />
                <span className="px-emote" aria-hidden />
              </div>
              <div className="px-name">
                {agent.name}
                {m.title && <em>{m.title}</em>}
              </div>
            </div>
          );
        })}

        {deskAgents.length === 0 && (
          <div className="px-empty">还没有员工入驻，先在「办公室」页接入或新建工位。</div>
        )}
      </div>

      {/* 选中成员的形象面板 */}
      {selectedAgent && (
        <div className="px-panel" onClick={(e) => e.stopPropagation()}>
          <div className="px-panel-head">
            <strong>{selectedAgent.name}</strong>
            <span className="muted">
              {(selectedAgent.meta as AgentMeta).title ?? ""} · {selectedAgent.status}
            </span>
            <button className="icon-btn" title="关闭" onClick={() => setSelected(null)}>
              ×
            </button>
          </div>
          {(selectedAgent.meta as AgentMeta).lastActivity && (
            <p className="px-panel-activity">{(selectedAgent.meta as AgentMeta).lastActivity}</p>
          )}
          <div className="px-panel-actions">
            <button
              className="primary-btn sm"
              disabled={busyAction}
              onClick={() => fileRef.current?.click()}
            >
              上传形象图
            </button>
            {(selectedAgent.meta as AgentMeta).spriteUrl && (
              <button className="ghost-btn" disabled={busyAction} onClick={() => void clearSprite()}>
                清除形象
              </button>
            )}
          </div>
          <div className="px-gen">
            <textarea
              placeholder="描述想要的形象，如：库洛米，紫黑配色，戴着小恶魔头饰（交给本机 codex 画像素风 SVG）"
              value={genPrompt}
              rows={2}
              disabled={busyAction}
              onChange={(e) => setGenPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void generateSprite();
                }
              }}
            />
            <button
              className="ghost-btn"
              disabled={busyAction}
              onClick={() => void generateSprite()}
            >
              {busyAction ? "生成中…" : "✨ AI 生成形象"}
            </button>
          </div>
          <p className="px-panel-hint">
            支持 PNG / GIF / WebP（透明底最佳）。想要库洛米、皮卡丘、吉伊卡哇？
            找一张透明底立绘传上来效果最好；AI 生成走本机 codex，约需 10–60 秒。
          </p>
          {error && <div className="form-error">{error}</div>}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadSprite(f);
              e.target.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}
