import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-n8n-workflow-graph-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server, buildN8nWorkflowGraph } = await import('../../server.mjs');
after(() => server.close());

const inboundCred = { id: 'cred-inbound-1', name: 'Gakai Inbound Secret' };
const llmCred = { id: 'cred-llm-1', name: 'Gakai LLM Proxy' };

test('buildN8nWorkflowGraph (standard) never produces an outbound "Send Reply" HTTP node — the actual reported bug', () => {
  // The whole point of this redesign: n8n never calls back into Gakai's own
  // API, so there's no host/URL for it to get wrong (okame.local, a LAN IP,
  // 127.0.0.1 — none of it matters anymore because this node doesn't exist).
  const { nodes } = buildN8nWorkflowGraph({ kind: 'standard', webhookPath: 'gakai-acct1', inboundCred });
  assert.equal(nodes.some(node => node.type === 'n8n-nodes-base.httpRequest'), false);
});

test('buildN8nWorkflowGraph (standard) wires Webhook -> Set -> Respond to Webhook, with responseMode set to wait for it', () => {
  const { nodes, connections } = buildN8nWorkflowGraph({ kind: 'standard', webhookPath: 'gakai-acct1', inboundCred });

  const webhook = nodes.find(node => node.name === 'Webhook');
  assert.equal(webhook.type, 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.responseMode, 'responseNode', 'must wait for the Respond to Webhook node instead of acking immediately');
  assert.equal(webhook.parameters.path, 'gakai-acct1');
  assert.equal(webhook.credentials.httpHeaderAuth.id, inboundCred.id);

  assert.ok(nodes.some(node => node.name === 'Set' && node.type === 'n8n-nodes-base.set'));
  const respond = nodes.find(node => node.name === 'Respond to Webhook');
  assert.equal(respond.type, 'n8n-nodes-base.respondToWebhook');
  assert.equal(respond.parameters.respondWith, 'json');
  assert.match(respond.parameters.responseBody, /reply:/);

  assert.deepEqual(connections.Webhook.main[0][0].node, 'Set');
  assert.deepEqual(connections.Set.main[0][0].node, 'Respond to Webhook');
});

test('buildN8nWorkflowGraph (agentic) wires Webhook -> AI Agent -> Respond to Webhook, with the LLM feeding the agent', () => {
  const { nodes, connections } = buildN8nWorkflowGraph({
    kind: 'agentic', webhookPath: 'gakai-acct1-ai', inboundCred,
    accountLlm: { model: 'gpt-test' }, llmCred, systemPrompt: 'Be helpful.',
  });

  assert.equal(nodes.some(node => node.type === 'n8n-nodes-base.httpRequest'), false);
  const agent = nodes.find(node => node.name === 'AI Agent');
  assert.equal(agent.type, '@n8n/n8n-nodes-langchain.agent');
  assert.equal(agent.parameters.options.systemMessage, 'Be helpful.');
  const model = nodes.find(node => node.name === 'OpenAI Chat Model');
  assert.equal(model.credentials.openAiApi.id, llmCred.id);
  assert.ok(nodes.some(node => node.name === 'Respond to Webhook' && node.type === 'n8n-nodes-base.respondToWebhook'));

  assert.deepEqual(connections.Webhook.main[0][0].node, 'AI Agent');
  assert.deepEqual(connections['OpenAI Chat Model'].ai_languageModel[0][0].node, 'AI Agent');
  assert.deepEqual(connections['AI Agent'].main[0][0].node, 'Respond to Webhook');
});
