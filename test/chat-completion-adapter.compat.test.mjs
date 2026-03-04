import assert from 'node:assert/strict';
import test from 'node:test';

import { CCCToMCPCMAdapter } from '../dist/security/chat-completion-adapter.js';

const request = {
  model: 'gpt-4-turbo',
  messages: [
    { role: 'system', content: 'You are a test assistant.' },
    { role: 'user', content: 'Evaluate this command.' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'evaluate_command_security',
        description: 'Evaluate command safety',
        parameters: {
          type: 'object',
          properties: {
            evaluation_result: { type: 'string' },
            reasoning: { type: 'string' },
          },
          required: ['evaluation_result', 'reasoning'],
        },
      },
    },
  ],
  tool_choice: {
    type: 'function',
    function: { name: 'evaluate_command_security' },
  },
};

test('chat adapter accepts camelCase toolCalls responses', async () => {
  const adapter = new CCCToMCPCMAdapter(async () => ({
    content: { type: 'text', text: '' },
    stopReason: 'tool_use',
    toolCalls: [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'evaluate_command_security',
          arguments: JSON.stringify({
            evaluation_result: 'allow',
            reasoning: 'safe command',
          }),
        },
      },
    ],
  }));

  const response = await adapter.chatCompletion(request);
  const message = response.choices[0]?.message;

  assert.equal(response.choices[0]?.finish_reason, 'tool_calls');
  assert.equal(Array.isArray(message?.tool_calls), true);
  assert.equal(message?.tool_calls?.length, 1);
  assert.equal(message?.tool_calls?.[0]?.function?.name, 'evaluate_command_security');
});

test('chat adapter accepts native tool_use content responses', async () => {
  const adapter = new CCCToMCPCMAdapter(async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'native_1',
        name: 'evaluate_command_security',
        input: {
          evaluation_result: 'deny',
          reasoning: 'potentially harmful',
        },
      },
    ],
    stopReason: 'tool_use',
  }));

  const response = await adapter.chatCompletion(request);
  const message = response.choices[0]?.message;

  assert.equal(response.choices[0]?.finish_reason, 'tool_calls');
  assert.equal(Array.isArray(message?.tool_calls), true);
  assert.equal(message?.tool_calls?.length, 1);
  assert.equal(message?.tool_calls?.[0]?.id, 'native_1');
  assert.equal(message?.tool_calls?.[0]?.function?.name, 'evaluate_command_security');
});
