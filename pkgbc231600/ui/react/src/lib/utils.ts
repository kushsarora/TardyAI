/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge doesn't know about c3 typography utilities (text-c3-bold-label-l2 etc.),
 * so by default it strips them when they appear alongside other text-* classes
 * (e.g. text-[color:var(...)]). Register the c3-* font-size prefix here so merge
 * understands `text-c3-...` belongs to the font-size group, separate from text-color.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: [(classPart: string) => classPart.startsWith('c3-')] }],
    },
  },
});

/**
 * Merges class names using clsx and tailwind-merge.
 * Handles conditional classes, arrays, and Tailwind CSS conflict resolution.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
