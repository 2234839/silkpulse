/** React FiberRoot 的最小形状（current 指向当前 HostRoot fiber） */
export interface ReactFiberRoot {
  current?: unknown;
}

/**
 * 容器上的 HostRoot fiber 归一化为 DevTools 需要的 FiberRoot。
 *
 * React 提交更新后会切换 root.current，而容器仍可能指向 alternate fiber；
 * stateNode 才稳定指向真实 FiberRoot，不能用 current 与容器 fiber 是否相等来校验。
 */
export function toReactFiberRoot(fiber: object): ReactFiberRoot {
  const stateNode: unknown = Reflect.get(fiber, "stateNode");
  if (stateNode !== null && typeof stateNode === "object" && "current" in stateNode) {
    return stateNode;
  }
  return { current: fiber };
}

/** 读取 React 18+ 挂在 root 容器上的 HostRoot fiber */
function getReactContainerFiber(container: Document | Element): object | null {
  const key = Object.getOwnPropertyNames(container).find((name) =>
    name.startsWith("__reactContainer$"),
  );
  if (!key) return null;
  const fiber: unknown = Reflect.get(container, key);
  return fiber !== null && typeof fiber === "object" ? fiber : null;
}

/** Document 自身也可能是 root 容器，例如 Next.js App Router 的 hydrateRoot(document, ...) */
function getReactRootCandidates(): Array<Document | Element> {
  return [document, ...document.querySelectorAll("*")];
}

/** 框架探测：只要求容器已登记，与原有 DOM 探测语义一致 */
export function hasReactRootContainer(): boolean {
  return getReactRootCandidates().some((container) => getReactContainerFiber(container) !== null);
}

/** 后注入恢复：从 document 与所有 Element 中收集已完成挂载的 FiberRoot */
export function findReactRoots(): ReactFiberRoot[] {
  const roots: ReactFiberRoot[] = [];
  for (const container of getReactRootCandidates()) {
    const fiber = getReactContainerFiber(container);
    if (!fiber) continue;
    const root = toReactFiberRoot(fiber);
    if (root.current) roots.push(root);
  }
  return roots;
}
