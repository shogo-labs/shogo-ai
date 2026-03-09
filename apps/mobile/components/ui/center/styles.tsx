// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { tva } from '@gluestack-ui/utils/nativewind-utils';
import { isWeb } from '@gluestack-ui/utils/nativewind-utils';

const baseStyle = isWeb ? 'flex flex-col relative z-0' : '';

export const centerStyle = tva({
  base: `justify-center items-center ${baseStyle}`,
});
