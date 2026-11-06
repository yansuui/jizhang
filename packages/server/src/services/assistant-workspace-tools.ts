import type { InternalTool, AssistantToolContext, AssistantToolDefinition } from './assistant-tool-registry.js';
import { assistantJsonObject, type AssistantJsonObject, type AssistantToolName } from './assistant-types.js';
import { AssistantWorkspaceStore, NATIVE_ACTIONS, WORKSPACE_KINDS, workspaceError, workspaceOnly } from './assistant-workspace-store.js';
import { ItemService } from './item-service.js';
import { dailyReviewFacts } from './assistant-daily-review.js';

export function workspaceCapabilities(items: readonly AssistantToolDefinition[]): AssistantJsonObject {
  return { version: 1, items: items.map(({ name, description, access }) => ({ name, description, access })), nativeActions: NATIVE_ACTIONS.map((v) => ({ ...v })) };
}
export function requiresWorkspaceV1(name: string): boolean { return name.startsWith('workspace.') || name === 'capabilities.list'; }
export function createWorkspaceTools(): InternalTool[] {
  const defs: AssistantToolDefinition[] = [
    { name: 'capabilities.list', access: 'read', description: '查询所有账本能力与受信任原生入口；修改必须由用户确认。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'workspace.open', access: 'read', description: '打开受信任原生工作区；密码/密钥/文件不得写入对话。只返回入口，不能宣称保存成功。', inputSchema: { type: 'object', properties: { destination: { enum: NATIVE_ACTIONS.map((v) => v.destination) }, itemId: { type: 'string' } }, required: ['destination'], additionalProperties: false } },
    { name: 'workspace.select', access: 'read', description: '请用户通过可搜索分页卡片选择真实业务记录或日期范围。账单选择保留from/to、账户、分类、标签筛选；返回后等待选择，不要猜测编号或循环查询。', inputSchema: { type: 'object', properties: { kind: { enum: [...WORKSPACE_KINDS] }, question: { type: 'string', maxLength: 200 }, multiple: { type: 'boolean' }, type: { enum: [0, 1] }, q: { type: 'string', maxLength: 200 }, from: { type: 'integer' }, to: { type: 'integer' }, accountId: { type: 'string' }, categoryId: { type: 'string' }, tagId: { type: 'string' } }, required: ['kind', 'question'], additionalProperties: false } },
    { name: 'daily.review', access: 'read', description: '读取某个账本自然日的完整权威收支（包含工资）、分类/账户拆分及待核对线索；不修改账本。', inputSchema: { type: 'object', properties: { date: { type: 'string' }, timeZone: { enum: ['Asia/Shanghai'] } }, required: ['date', 'timeZone'], additionalProperties: false } },
  ];
  return defs.map((definition): InternalTool => ({ definition,
    parseArguments: (value) => {
      const args = assistantJsonObject(value, '工作区参数');
      workspaceOnly(args, Object.keys(definition.inputSchema['properties'] as AssistantJsonObject));
      if (definition.name === 'workspace.select' && (!WORKSPACE_KINDS.includes(args['kind'] as typeof WORKSPACE_KINDS[number]) || typeof args['question'] !== 'string' || !args['question'].trim() || args['question'].length > 200 || (args['multiple'] !== undefined && typeof args['multiple'] !== 'boolean') || (args['type'] !== undefined && args['type'] !== 0 && args['type'] !== 1) || (args['q'] !== undefined && (typeof args['q'] !== 'string' || args['q'].length > 200)))) workspaceError(400, 'INVALID', '选择卡参数无效。');
      for (const key of ['from', 'to']) if (args[key] !== undefined && !Number.isSafeInteger(args[key])) workspaceError(400, 'INVALID', '选择日期边界无效。');
      for (const key of ['accountId', 'categoryId', 'tagId']) if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > 200 || !args[key])) workspaceError(400, 'INVALID', '选择筛选编号无效。');
      if (typeof args['from'] === 'number' && typeof args['to'] === 'number' && args['from'] >= args['to']) workspaceError(400, 'INVALID', '选择日期范围无效。');
      return args;
    },
    read: (c: AssistantToolContext, args) => {
      if (requiresWorkspaceV1(definition.name) && (!c.generationId || !new AssistantWorkspaceStore(c.db, c.now).enabled(c.generationId))) workspaceError(400, 'INVALID', '当前客户端未启用对话工作区，请使用普通查询或更新客户端。');
      let data: AssistantJsonObject;
      let summary: string;
      switch (definition.name) {
        case 'capabilities.list': data = workspaceCapabilities(c.capabilityCatalog ?? []); summary = '可以通过对话查询、选择和准备修改；受保护操作在原生工作区完成。'; break;
        case 'daily.review': data = dailyReviewFacts(c, args); summary = `${String(args['date'])} 每日复盘事实（只读）`; break;
        case 'workspace.select': data = { workspace: new AssistantWorkspaceStore(c.db, c.now).createSelection(c, args) }; summary = '请在选择卡中核对并选择，选择本身不会修改账本。'; break;
        case 'workspace.open': {
          const native = NATIVE_ACTIONS.find((v) => v.destination === args['destination']);
          if (!native || !c.generationId || !new AssistantWorkspaceStore(c.db, c.now).enabled(c.generationId)) workspaceError(400, 'INVALID', '当前工作区入口不可用。');
          const itemId = args['itemId'];
          if ('requiresItem' in native) {
            if (typeof itemId !== 'string') workspaceError(400, 'INVALID', '请先选择物品。');
            new ItemService(c.db, { now: c.now, actorId: c.actorId }).getByIdOrThrow(itemId);
          } else if (itemId !== undefined) workspaceError(400, 'INVALID', '此入口不接受物品编号。');
          data = { nativeAction: { destination: native.destination, ...(typeof itemId === 'string' ? { itemId } : {}) } }; summary = `请打开${native.title}，按页面核对并确认。`; break;
        }
        default: throw new Error('Unreachable workspace definition');
      }
      return { toolName: definition.name as AssistantToolName, summary, data };
    },
  }));
}
