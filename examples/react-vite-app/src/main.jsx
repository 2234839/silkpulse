import { createRoot } from "react-dom/client";
import { useState } from "react";
import { createElement } from "react";

/** 子组件：验证组件树层级（hooks 在这里，inspect hooks 用） */
function UserCard({ name, age }) {
  return createElement(
    "div",
    { className: "user" },
    createElement("strong", null, name),
    `（${age} 岁）`,
  );
}

function ProdApp() {
  const [count, setCount] = useState(42);
  const [userName] = useState("gs");
  return createElement(
    "div",
    { className: "app" },
    createElement("h1", null, "React vite build 页面"),
    createElement("div", { className: "counter" }, String(count)),
    createElement(
      "button",
      {
        id: "inc-btn",
        onClick: () => setCount((c) => c + 1),
      },
      "+1",
    ),
    createElement(UserCard, { name: userName, age: 18 }),
  );
}

/** 页面就绪标记（测试脚本等这个） */
window.__TEST_PAGE_READY__ = true;
createRoot(document.getElementById("root")).render(createElement(ProdApp));
