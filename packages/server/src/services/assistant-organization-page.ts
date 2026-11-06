import type { AiOrganizationPreview } from './ai-types.js';
import { assistantJsonObject } from './assistant-types.js';
import type { AssistantToolResult } from './assistant-tool-registry.js';
import { workspaceError } from './assistant-workspace-store.js';

export function organizationPage(preview: AiOrganizationPreview, offset = 0, limit = 30): AssistantToolResult {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) workspaceError(400, 'INVALID', '整理分页条件无效。');
  const actions = preview.actions.slice(offset, offset + limit);
  return { toolName: 'organization.preview', summary: `尚未修改账本；本页展示 ${actions.length} 项整理建议，共 ${preview.actions.length} 项。`,
    data: assistantJsonObject({ ...preview, actions, totalActions: preview.actions.length, offset, limit, hasMore: offset + actions.length < preview.actions.length }, '结构整理分页') };
}
