<script setup lang="ts">
/**
 * 《hello silkpulse》—— blog 首发帖，宣扬本项目
 *
 * 内嵌一个交互 demo：模拟 AI agent 用 silkpulse skill 远程诊断的完整会话
 * （devices → snapshot → errors → exec → 结论），打字机逐行回放。
 */
import { onMounted, onUnmounted, ref } from "vue";

/** 终端行的类型（决定配色/前缀） */
type LineKind = "cmd" | "out" | "err" | "ok" | "ai" | "dim";

interface ScriptLine {
  kind: LineKind;
  text: string;
  /** 打字机逐字输出（仅 cmd/ai 行） */
  typewriter?: boolean;
}

/** 诊断会话剧本 —— 还原一次真实的 AI 远程诊断闭环 */
const SCRIPT: ScriptLine[] = [
  { kind: "dim", text: "# 测试反馈：iPhone 测试机上下单页白屏，本地无法复现" },
  {
    kind: "ai",
    text: "测试同学报告移动端下单页白屏，我先用 silkpulse 看一下在线设备。",
    typewriter: true,
  },
  { kind: "cmd", text: "$ silkpulse devices", typewriter: true },
  {
    kind: "out",
    text: "dev-a1b2  📱 iPhone 15 · Safari · 375×667  https://shop.example.com/checkout",
  },
  { kind: "err", text: "         ⚠ 3 errors (置顶)" },
  { kind: "cmd", text: "$ silkpulse errors dev-a1b2 5", typewriter: true },
  { kind: "err", text: "TypeError: Cannot read properties of null (reading 'price')" },
  { kind: "dim", text: "  at n (checkout.min.js:1:4821)" },
  { kind: "ok", text: "  → source map 已解析: checkout/OrderSummary.tsx:42:18" },
  {
    kind: "ai",
    text: "错误指向 OrderSummary 组件，我取个页面快照确认渲染到了哪一步。",
    typewriter: true,
  },
  { kind: "cmd", text: "$ silkpulse snapshot dev-a1b2", typewriter: true },
  { kind: "out", text: "# viewport: 375×667  url: /checkout" },
  { kind: "out", text: "[0] <body> [1] <div id=app> [2] <div.checkout>" },
  { kind: "out", text: '[3] <h1 "确认订单"> [4] <div.cart ✗空>' },
  { kind: "dim", text: "  <!-- OrderSummary 未渲染，购物车数据为空 -->" },
  { kind: "cmd", text: "$ silkpulse exec dev-a1b2", typewriter: true },
  { kind: "out", text: "> return __silkpulse_storage('local')\"" },
  { kind: "out", text: '{ "cart_items": null, "cart_ts": "…" }' },
  {
    kind: "ai",
    text: "根因找到：购物车接口返回 null 未兜底，移动端分支缺省直接崩了 OrderSummary。",
    typewriter: true,
  },
  {
    kind: "ai",
    text: "我在设备上验证一下修复假设——给 cart 一个空数组兜底后页面能否恢复。",
    typewriter: true,
  },
  { kind: "cmd", text: "$ silkpulse exec dev-a1b2", typewriter: true },
  {
    kind: "out",
    text: '> localStorage.setItem("cart_items", JSON.stringify([])); location.reload()',
  },
  { kind: "ok", text: "✓ 页面已恢复渲染，OrderSummary 正常展示（快照复核）" },
  {
    kind: "ai",
    text: "结论：/checkout 移动端对 cart_items=null 缺兜底 → OrderSummary 崩溃白屏。建议修复点 OrderSummary.tsx:42。诊断完成 ✓",
    typewriter: true,
  },
];

/** 已渲染的行 */
const rendered = ref<{ id: number; kind: LineKind; text: string }[]>([]);
/** 是否正在播放 */
const playing = ref(false);
/** 是否播放过（控制重播按钮文案） */
const finished = ref(false);
let lineId = 0;
let cancelled = false;

/** 终端 DOM 引用（自动滚动到底） */
const termEl = ref<HTMLElement | null>(null);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 播放整个会话剧本 */
async function play() {
  if (playing.value) return;
  playing.value = true;
  finished.value = false;
  rendered.value = [];
  lineId = 0;
  await sleep(400);
  for (const line of SCRIPT) {
    if (cancelled) return;
    if (line.typewriter) {
      /** 打字机：先插入空行再逐字填充 */
      const id = lineId++;
      rendered.value.push({ id, kind: line.kind, text: "" });
      for (let i = 1; i <= line.text.length; i++) {
        if (cancelled) return;
        const target = rendered.value.find((l) => l.id === id);
        if (target) target.text = line.text.slice(0, i);
        scrollToBottom();
        await sleep(line.kind === "cmd" ? 26 : 14);
      }
      await sleep(260);
    } else {
      /** 输出行整行出现 */
      rendered.value.push({ id: lineId++, kind: line.kind, text: line.text });
      scrollToBottom();
      await sleep(line.kind === "err" ? 500 : 200);
    }
  }
  playing.value = false;
  finished.value = true;
}

/** 终端容器滚到底部 */
function scrollToBottom() {
  requestAnimationFrame(() => {
    if (termEl.value) termEl.value.scrollTop = termEl.value.scrollHeight;
  });
}

onMounted(() => {
  cancelled = false;
  play();
});
onUnmounted(() => {
  cancelled = true;
});
</script>

<template>
  <article class="blog-content">
    <p>
      一个再熟悉不过的场景：测试同学提了个 bug——<strong>"你们那个页面在测试机上白屏了"</strong>。
      你让他截图，他发来一张白得发光的照片；你让他描述，他说"就是打不开"。
      你打开本地环境——一切正常。开发环境和测试机之间，隔着一堵墙。
    </p>
    <p>
      如果恰好在同一个办公室，还能把测试机拿到工位上插线连 DevTools；
      但更常见的是<strong>远程协作</strong>——测试团队在另一个城市、外包驻场在客户那边、甚至隔着时区在地球另一端，
      插线根本不可能。只能靠截图、录屏、远程会议"你来点我来看"，信息在来回传递中层层失真，
      拉日志、猜原因、发补丁、再扔回去验证，一轮下来半天没了。
    </p>

    <h2>silkpulse 是什么</h2>
    <p>
      <strong>silkpulse 是一个 AI 原生的远程设备调试器</strong>：让 AI agent 直接查看、诊断、操作
      运行在远程设备上的网页——线上 H5、移动端浏览器、webview，所有本地 DevTools 够不着的地方。
    </p>
    <blockquote>
      <p>定位 = PageSpy 的远程多端调试能力 + vite-plugin-pilot 的 AI-native 注入哲学。</p>
    </blockquote>
    <p>
      和传统远程调试工具最大的区别在<strong>接入方式</strong>：PageSpy/chii 面向"人盯着控制台看"，
      silkpulse 的第一公民是 AI——所有能力都通过 <strong>skill + HTTP API</strong> 暴露， agent
      像调用函数一样调用"取快照 / 读错误 / 执行诊断代码"。
    </p>

    <h2>为什么叫 silkpulse：悬丝诊脉</h2>
    <p>
      《西游记》第六十九回，朱紫国国王染疾三年，悟空揭了皇榜。国王见这毛脸雷公嘴的和尚，
      不敢让他当面诊脉，悟空便取出三条金线，让宫人系在国王腕上，自己捏住线头隔着帘幕诊脉——
      这就是<strong>悬丝诊脉</strong>：碰不到人，却照样号准了脉。故事里还有个妙处：
      内侍不信，故意把线拴在别处试探，被行者张口道破——<strong>线没系在病人身上，再细也是白搭</strong>。
    </p>
    <p>这个典故几乎就是本项目的完整隐喻：</p>
    <table>
      <thead>
        <tr>
          <th>朱紫国行医</th>
          <th>silkpulse</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>国王不敢见生人，不能近身诊脉</td>
          <td>设备远在别处，无法插线连 DevTools</td>
        </tr>
        <tr>
          <td>三根金线</td>
          <td>注入页面的一段轻量 SDK（iife 单文件，无依赖）</td>
        </tr>
        <tr>
          <td>丝线传导寸关尺的搏动</td>
          <td>WebSocket 实时上报 console / 错误 / 网络 / DOM 状态</td>
        </tr>
        <tr>
          <td>诊出"双鸟失群"，病根是妖王掳走了王后</td>
          <td>不止读症状（报错），还往下挖根因（存储 / 网络 / 环境）</td>
        </tr>
        <tr>
          <td>降妖救后，沉疴得愈</td>
          <td>exec 通道：操作元素、验证修复假设，闭环收尾</td>
        </tr>
      </tbody>
    </table>
    <p>
      所以是 <strong>silk</strong>（丝）+ <strong>pulse</strong>（脉搏）：丝线要细（接入零负担），
      搏动要真（数据不丢不骗——系在床腿上的线，号不出人的脉），执线的人要会诊 （AI
      能读懂并行动），诊完还要<strong>除根</strong>（不止于看，能操作、能验证）。
      悟空若只开药不降妖，国王的病好不了；调试工具若只能看不能操作，诊断也到不了终点。
    </p>

    <h2>看一段真实的 AI 诊断会话</h2>
    <p>
      下面是一个<strong>可交互的模拟会话</strong>，还原 AI agent
      拿到"移动端白屏"反馈后的完整诊断闭环—— 从发现设备、读错误、解析 source
      map、取快照，到在真实设备上验证修复假设：
    </p>

    <!-- 交互 demo：AI 远程诊断会话回放 -->
    <div class="not-prose my-6">
      <div class="rounded-xl border border-base overflow-hidden bg-surface shadow-sm">
        <!-- 终端窗口头 -->
        <div class="flex items-center justify-between px-4 py-2.5 bg-elevated border-b border-base">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-red-400"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-yellow-400"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-green-400"></span>
            <span class="ml-2 text-xs text-muted font-mono">ai-agent · silkpulse skill</span>
          </div>
          <button
            @click="play"
            :disabled="playing"
            class="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {{ playing ? "诊断中…" : finished ? "↻ 重播" : "▶ 播放" }}
          </button>
        </div>
        <!-- 终端内容 -->
        <div
          ref="termEl"
          class="h-80 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed space-y-1"
        >
          <div v-for="line in rendered" :key="line.id">
            <!-- AI 思考行 -->
            <p v-if="line.kind === 'ai'" class="text-indigo-400 flex gap-1.5">
              <span class="select-none flex-shrink-0">🤖</span><span>{{ line.text }}</span>
            </p>
            <!-- 命令行 -->
            <p v-else-if="line.kind === 'cmd'" class="text-emerald-400">
              {{ line.text }}<span v-if="line.text.length > 0 && !playing" class="opacity-0"></span
              ><span
                class="inline-block w-1.5 h-3.5 align-middle bg-emerald-400/70 ml-0.5 animate-pulse"
                v-if="playing"
              ></span>
            </p>
            <!-- 普通输出 -->
            <p v-else-if="line.kind === 'out'" class="text-secondary pl-5">{{ line.text }}</p>
            <!-- 错误输出 -->
            <p v-else-if="line.kind === 'err'" class="text-red-400 pl-5">{{ line.text }}</p>
            <!-- 成功输出 -->
            <p v-else-if="line.kind === 'ok'" class="text-cyan-400 pl-5">{{ line.text }}</p>
            <!-- 注释/弱信息 -->
            <p v-else class="text-faint pl-5">{{ line.text }}</p>
          </div>
        </div>
      </div>
    </div>
    <p>
      注意最后两步：AI 不只是"看"，还能通过 <strong>exec 通道</strong>在远程设备执行任意诊断 JS、
      操作元素、验证假设——<strong>远程诊断 → 操作 → 验证</strong>，一个 agent 闭环完成。
    </p>
    <p>
      对远程协作来说这是质变：测试同学只需把页面<strong>接入一次</strong>（贴一个 script
      标签，或点一下 bookmarklet）， 之后无论谁在何时接手，AI
      都能直接看到设备的实时状态，不需要再拉着测试同学"配合复现"——
      异地、时差、驻场外包，都不再是障碍。这正是"远程设备调试器"和"本地 DevTools"的本质区别：
      调试能力不再要求你人在设备旁边。
    </p>
    <p>
      打开真实的 silkpulse
      控制台，就是这样的画面——左侧在线设备列表（有错误的设备自动置顶），右侧是设备实时上报的 console
      日志：
    </p>
    <figure>
      <img
        src="/blog/console-panel.png"
        alt="silkpulse 控制台：左侧设备列表，右侧 console 日志采集"
        loading="lazy"
      />
      <figcaption>
        真实的 silkpulse 控制台：左侧在线设备，右侧 console 采集（支持按级别过滤、搜索、一键复制）
      </figcaption>
    </figure>

    <h2>不依赖 CDP：服务端有公网，就能连任意终端</h2>
    <p>
      传统远程调试多基于 <strong>CDP（Chrome DevTools Protocol）</strong>：要东设备开调试端口（
      <code>--remote-debugging-port</code>）或走 adb/USB 转发，意味着你必须能"碰到"那台设备、
      能控它的启动参数。别人的手机、客户环境里的 webview、生产环境 App 内嵌页，这些都做不到； 而且
      CDP 基本只覆盖 Chromium 系，iOS Safari 直接出局。
    </p>
    <p>
      silkpulse 的数据通道完全不同：<strong
        >往页面里注入一段 SDK，设备主动通过 WebSocket 出站连到你的服务端</strong
      >。 这个方向反转是关键——出站连接天然穿透 NAT、公司防火墙、移动运营商网络，设备不需要任何
      公网地址或开放端口。所以唯一的部署要求是：<strong
        >silkpulse 服务端有一个可访问的公网地址</strong
      >
      （域名 + HTTPS），之后任何能打开网页的终端——手机、平板、iOS/Android、webview、
      甚至智能电视——只要能加载页面就能接入，浏览器内核无关。
    </p>
    <blockquote>
      <p>
        CDP 是"你走到设备旁边去连它"；silkpulse
        是"页面自己走出来找你"。这就是为什么它能调试那些你碰不到的设备。
      </p>
    </blockquote>

    <h2>更糟的情况：终端连 CDP 能力都没有</h2>
    <p>
      上一节说的还是"有 CDP 但你够不着"；还有一大类终端是<strong>压根没开 CDP 能力</strong>。
      企业微信、微信这类 App 的内置浏览器就是典型：iOS 的 WKWebView 需要 App 显式声明
      <code>isInspectable</code>，Android 的 WebView 需要开启
      <code>setWebContentsDebuggingEnabled</code>——开关在 App 厂商手里， 第三方开发者既改不了宿主
      App，也拿不到桌面端 inspect 的入场券。 你在这些容器里跑的 H5，出了问题就是"黑盒"。
    </p>
    <p>
      这个领域此前的民间解法是
      <strong>vConsole / Eruda</strong> 这类<strong>页面内调试面板</strong>——
      往页面里塞一个悬浮按钮，点开一个手机上的 mini DevTools。它们解决了"有没有"，
      但用过的都懂那份憋屈：
    </p>
    <ul>
      <li>
        <strong>小屏挤面板</strong
        >——手机屏幕上叠一层半透明面板，按钮比米粒大不了多少，误触、挡内容、长日志基本没法读
      </li>
      <li>
        <strong>看的人和点的人不是同一个</strong
        >——设备在测试同学手上，面板也在他手上；你在电话这头"指挥"：<em
          >"点开 Console……往上滑……就那条红的，展开……复制发我"</em
        >，一句操作来回三分钟
      </li>
      <li><strong>没有协作接口</strong>——面板里的东西贴不到 issue 里、喂不给 AI，全靠人肉转录</li>
    </ul>
    <p>
      说白了，vConsole 是把 DevTools <strong>塞进了被调试的设备里</strong>，让人在最小的屏幕上、
      以最低的效率做本该在桌面做的事。silkpulse 把这个关系倒了回来：
      <strong>调试面板渲染在开发者的桌面浏览器里</strong>（就是完整的控制台，可搜索、可复制、可生成
      AI 上下文）， 设备上只有一根安静的"丝线"。测试同学什么都不用装、不用点；AI
      接入后连"指挥"这个环节都消失了—— 它自己看、自己点、自己验证。
    </p>

    <h2>silkpulse 不解决什么（同样重要）</h2>
    <p>
      先把边界画清楚：<strong>能进编译层、能开调试端口的场景，不需要 silkpulse</strong>。 本地 dev
      server + DevTools 就是那里的最优解，我们没有兴趣替代它—— 能拿到
      localhost:9229、能插桩、能复现的代码，用更顺手的工具。
    </p>
    <p>
      silkpulse 的目标恰恰是那些<strong>"没法控制的、被嵌套的憋屈小前端"</strong>： App 里嵌的
      H5、客户环境中的 webview、第三方平台容器里跑的页面—— 它们不是"没配置好调试"，而是<strong
        >从架构上就拿不到 DevTools 的入场券</strong
      >。 两类场景不存在谁取代谁，是同一条业务链路上前后两段不同的困局。
    </p>
    <p>
      另一个常见反问是"既然能改代码接 SDK，为什么不直接用 CDP？"—— 因为<strong
        >注入 SDK 改的是"我自己的页面"，走 CDP 要控的是"别人的设备"</strong
      >： 前者只需在自己的 html 里贴一行 script，后者要求设备开调试端口、装 adb、建隧道。
      改自己的代码永远比控别人的设备容易，这也是出站连接方案的立足点。 还要说明一点边界：silkpulse
      调试的是<strong>测试设备</strong>——
      测试同学维护的测试机、已授权的预发环境，而不是真实用户的手机。
      诊断工具的底线是授权，这一点没有含糊。
    </p>

    <h2>AI 看到的世界长什么样</h2>
    <p>
      silkpulse 的快照格式专为 AI 设计（compact 文本，稳定索引），一眼可见页面结构、表单状态、
      视口信息，还带 <code>__silkpulse_click(idx)</code> 这类辅助函数让 AI 能直接"点"到元素：
    </p>
    <pre><code># viewport: 375×667  url: https://shop.example.com/checkout
[0] &lt;body&gt;
 [1] &lt;div id="app"&gt;
  [2] &lt;div class="checkout"&gt;
   [3] &lt;h1 "确认订单"&gt;
   [4] &lt;form&gt;
    [5] &lt;input name="addr" value="北京市…" focus ✓required&gt;
    [6] &lt;select name="city"&gt; &lt;bj:北京|sh:上海|gz:广州&gt;
    [7] &lt;button "提交订单" disabled&gt;</code></pre>
    <p>
      每行开头的 <code>[idx]</code> 就是元素的"句柄"——AI 执行
      <code>__silkpulse_click(7)</code>、<code>__silkpulse_setValue(5, '新地址')</code>
      就能精确操作。 快照穿透 shadow DOM 和同源 iframe，React/Vue 受控组件的输入也做了框架兼容。
    </p>
    <p>
      下面是控制台 Snapshot 面板的真实现场——整页状态（含表单值、焦点、disabled/readonly/aria
      状态、最后的错误）被压缩成一段可以直接喂给 AI 的文本：
    </p>
    <figure>
      <img
        src="/blog/snapshot-panel.png"
        alt="silkpulse 控制台 Snapshot 面板：compact 快照全文"
        loading="lazy"
      />
      <figcaption>Snapshot 面板：~1.8KB 装下整页状态，AI 拿到的就是这个视图</figcaption>
    </figure>

    <h2>核心能力一览</h2>
    <ul>
      <li>
        <strong>console 采集</strong> —— 全级别劫持，安全序列化（限深限长），滑动窗口限流防 log 风暴
      </li>
      <li>
        <strong>network 采集</strong> —— HAR 风格，关键请求头/响应头、请求体双路采集、FormData
        字段名、XHR 全 responseType 兼容
      </li>
      <li>
        <strong>error 捕获</strong> —— window.onerror + unhandledrejection，<strong
          >自动 source map 解析</strong
        >，压缩代码直接定位到原始源码行；错误风暴自动聚合去重
      </li>
      <li>
        <strong>compact 快照</strong> —— ~400 字符压缩整页状态，含视口/全量表单状态/焦点元素，AI
        诊断"按钮点不了"时直接定位根因
      </li>
      <li>
        <strong>exec 通道</strong> —— AI 在远程设备执行任意诊断 JS，内置
        click/setValue/type/scroll/hover/pressKey/wait/storage/sourcemap 等辅助函数
      </li>
      <li>
        <strong>多设备并发 + 断线重连</strong> —— 指数退避重连，历史缓冲区完整保留；SDK
        离线缓冲不丢早期错误
      </li>
      <li>
        <strong>多形态接入</strong> —— script 标签 / bookmarklet / userscript，线上站不改源码也能接
      </li>
    </ul>
    <p>Network 和 Errors 面板的真实现场：</p>
    <figure>
      <img
        src="/blog/network-panel.png"
        alt="silkpulse 控制台 Network 面板：请求列表含 401/404"
        loading="lazy"
      />
      <figcaption>
        Network 面板：HAR 风格请求列表，方法 / 状态码 / 大小 / 耗时一目了然，401、404 直接标红
      </figcaption>
    </figure>
    <figure>
      <img
        src="/blog/errors-panel.png"
        alt="silkpulse 控制台 Errors 面板：错误列表含源码位置"
        loading="lazy"
      />
      <figcaption>
        Errors 面板：错误带源码位置，堆栈可展开，source map 自动解析到原始源码行
      </figcaption>
    </figure>

    <h2>AI 怎么接入</h2>
    <p>不需要 MCP，不需要跑额外进程——agent 通过一个 skill 脚本 + HTTP API 就能操作一切：</p>
    <pre><code># 1. 查看在线设备（有错误的自动置顶）
node tools/skill/scripts/silkpulse.mjs devices

# 2. 一键诊断聚合（错误 + 失败网络 + 慢请求 + 日志 + 快照，AI 最高效入口）
node tools/skill/scripts/silkpulse.mjs inspect dev-a1b2

# 3. 在设备上执行诊断代码（支持 stdin 传多行复杂代码）
echo 'return { title: document.title, cart: __silkpulse_storage() }' \
  | node tools/skill/scripts/silkpulse.mjs exec dev-a1b2</code></pre>
    <p>
      所有能力同时以 HTTP API 暴露（<code>/api/devices/:id/snapshot</code>、
      <code>/api/devices/:id/exec</code>……），任何能发 HTTP 的 agent 都能直接集成。
    </p>
    <p>
      Exec
      面板的真实现场——一段诊断代码发到远程设备执行，返回值结构化展示，执行后还能顺手取快照复核：
    </p>
    <figure>
      <img
        src="/blog/exec-panel.png"
        alt="silkpulse 控制台 Exec 面板：执行诊断代码并展示返回值"
        loading="lazy"
      />
      <figcaption>
        Exec 面板：在远程设备执行任意诊断 JS，返回值可展开检查，下方是执行历史
      </figcaption>
    </figure>

    <h2>快速开始</h2>
    <pre><code>git clone &lt;repo&gt; &amp;&amp; cd silkpulse
vp install
vp run -r build      # 构建所有包
vp run start         # 默认端口 8080

# 在目标页面注入 SDK
&lt;script src="http://localhost:8080/sdk.js"&gt;&lt;/script&gt;</code></pre>
    <p>
      部署极轻：构建后只需三个产物目录（server bundle + 静态资源 + demo 页）， 无需
      node_modules，一个 Node 进程 + 一份 Dockerfile 就能上线。
    </p>

    <h2>为什么现在需要它</h2>
    <p>
      AI 编程正在吃掉"写代码"这件事，但<strong>"诊断运行中的系统"</strong>一直是个缺口： 本地开发有
      vite-plugin-pilot 这类注入式调试，而线上/移动端长期只有"人肉看日志"。 silkpulse 把远程设备变成
      AI 可直接操作的实体——这不是让人失业， 而是把人从"猜"里解放出来，去做真正的决策。
    </p>
    <p>
      我们相信调试工具的下个形态就是 <strong>AI-native</strong>：工具不为"被看"设计，
      为"被调用"设计。silkpulse 是这个信念的一次完整落地。
    </p>

    <hr />
    <p>
      <strong>在线体验</strong>：
      <a href="https://silkpulse.heartstack.space" target="_blank" rel="noopener"
        >打开 silkpulse 控制台</a
      >
      （输入密钥或以访客身份进入），配合
      <a href="https://silkpulse.heartstack.space/test-page.html" target="_blank" rel="noopener"
        >已接入 SDK 的测试页</a
      >
      可以直接看到真实的采集效果。或者在
      <router-link to="/">本站控制台</router-link>
      里点"➕ 接入新设备"生成 bookmarklet，30 秒把任意线上页面接入进来。
    </p>
    <p class="text-faint">—— written by silkpulse team, 2026-08</p>
  </article>
</template>
