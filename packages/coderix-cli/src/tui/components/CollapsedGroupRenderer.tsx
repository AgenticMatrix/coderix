import React from 'react';
import { Box, Text } from '@coderix/ink';
import type { CollapsedGroup } from './collapseToolGroups.js';
import { getToolUseRenderer } from '../../tools/registry.js';

interface CollapsedGroupRendererProps {
  group: CollapsedGroup;
  contentExpanded?: boolean;
  termWidth?: number;
}

function buildSummary(group: CollapsedGroup): string {
  const parts: string[] = [];
  const { searchCount, readCount, listCount, isActive } = group;

  if (searchCount > 0) {
    const verb = isActive ? 'Searching for' : 'Searched for';
    parts.push(`${verb} ${searchCount} ${searchCount === 1 ? 'pattern' : 'patterns'}`);
  }

  if (readCount > 0) {
    const verb = isActive ? 'Reading' : 'Read';
    parts.push(`${verb} ${readCount} ${readCount === 1 ? 'file' : 'files'}`);
  }

  if (listCount > 0) {
    const verb = isActive ? 'listing' : 'listed';
    parts.push(`${verb} ${listCount} ${listCount === 1 ? 'directory' : 'directories'}`);
  }

  if (parts.length === 0) return '';

  const hint = isActive ? '… (Ctrl+O to expand)' : ' (Ctrl+O to expand)';
  return parts.join(', ') + hint;
}

export function CollapsedGroupRenderer({
  group,
  contentExpanded,
  termWidth,
}: CollapsedGroupRendererProps): React.ReactNode {
  const summary = buildSummary(group);
  const isActive = group.isActive;
  const indicator = isActive ? '○' : '●';
  const indicatorColor = isActive ? 'ansi:yellow' : 'ansi:green';

  // When expanded, show each individual tool
  if (contentExpanded) {
    return (
      <Box flexDirection="column">
        {group.blocks.map((block, idx) => {
          const Renderer = getToolUseRenderer(block.toolName);
          return (
            <Renderer
              key={idx}
              toolName={block.toolName}
              toolId={block.toolId}
              input={block.input}
              state={block.state}
              riskLevel={block.riskLevel}
              permissionState={block.permissionState}
              duration={block.duration}
              result={block.result}
              contentExpanded={contentExpanded}
              termWidth={termWidth}
            />
          );
        })}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text dimColor>{summary}</Text>
      </Text>
      {group.latestHint ? (
        <Box paddingLeft={3}>
          <Text dimColor>⎿ {group.latestHint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
