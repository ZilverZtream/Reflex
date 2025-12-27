/**
 * LIS Reconciliation Tests
 *
 * Tests the Longest Increasing Subsequence algorithm used for
 * optimal keyed list reconciliation.
 */

import { describe, it, expect } from 'vitest';
import { computeLIS } from '../src/core/reconcile.ts';

describe('computeLIS', () => {
  describe('Basic Cases', () => {
    it('should return empty array for empty input', () => {
      expect(computeLIS([])).toEqual([]);
    });

    it('should return single element for single input', () => {
      expect(computeLIS([0])).toEqual([0]);
    });

    it('should handle already sorted array', () => {
      const result = computeLIS([0, 1, 2, 3, 4]);
      expect(result).toEqual([0, 1, 2, 3, 4]);
    });

    it('should handle reverse sorted array', () => {
      const result = computeLIS([4, 3, 2, 1, 0]);
      // LIS of reverse sorted is length 1 (any single element)
      expect(result.length).toBe(1);
    });
  });

  describe('Complex Cases', () => {
    it('should find correct LIS for mixed array', () => {
      // Array: [2, 0, 1, 4, 3]
      // Possible LIS: [0, 1, 4] or [0, 1, 3] (length 3)
      const result = computeLIS([2, 0, 1, 4, 3]);
      expect(result.length).toBe(3);
      // Verify it's actually increasing
      const lis = result.map(i => [2, 0, 1, 4, 3][i]);
      for (let i = 1; i < lis.length; i++) {
        expect(lis[i]).toBeGreaterThan(lis[i - 1]);
      }
    });

    it('should handle array with duplicates by skipping -1', () => {
      // -1 represents new items that have no old position
      const result = computeLIS([-1, 0, 1, -1, 2]);
      // Only considers non-negative values: [0, 1, 2] at indices 1, 2, 4
      expect(result).toEqual([1, 2, 4]);
    });

    it('should handle all new items', () => {
      const result = computeLIS([-1, -1, -1]);
      expect(result).toEqual([]);
    });

    it('should handle interleaved old and new items', () => {
      const result = computeLIS([-1, 0, -1, 1, -1, 2]);
      // LIS of [0, 1, 2] at positions 1, 3, 5
      expect(result).toEqual([1, 3, 5]);
    });
  });

  describe('Performance Edge Cases', () => {
    it('should handle larger arrays efficiently', () => {
      // Generate a random-ish array
      const arr = Array.from({ length: 100 }, (_, i) => i % 7 === 0 ? -1 : Math.floor(i / 2));
      const result = computeLIS(arr);
      // Just verify it returns and has valid indices
      expect(result.length).toBeGreaterThan(0);
      result.forEach(idx => {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(arr.length);
      });
    });

    it('should be O(n log n)', () => {
      // This is more of a smoke test - actual performance testing
      // would require timing measurements
      const sizes = [10, 100, 1000];
      sizes.forEach(size => {
        const arr = Array.from({ length: size }, () => Math.floor(Math.random() * size));
        const start = performance.now();
        computeLIS(arr);
        const elapsed = performance.now() - start;
        // Should complete in reasonable time (< 100ms for 1000 elements)
        expect(elapsed).toBeLessThan(100);
      });
    });
  });

  describe('Real-world Reorder Scenarios', () => {
    it('should find optimal LIS for reverse (worst case)', () => {
      // Old: [A, B, C, D] -> indices [0, 1, 2, 3]
      // New: [D, C, B, A]
      // Old indices in new order: [3, 2, 1, 0]
      // LIS: just one element (length 1)
      const result = computeLIS([3, 2, 1, 0]);
      expect(result.length).toBe(1);
    });

    it('should handle move first to last', () => {
      // Old: [A, B, C, D]
      // New: [B, C, D, A]
      // Old indices: [1, 2, 3, 0]
      // LIS: [1, 2, 3] (B, C, D don't move)
      const result = computeLIS([1, 2, 3, 0]);
      expect(result.length).toBe(3);
      expect(result).toEqual([0, 1, 2]); // indices 0, 1, 2 contain [1, 2, 3]
    });

    it('should handle move last to first', () => {
      // Old: [A, B, C, D]
      // New: [D, A, B, C]
      // Old indices: [3, 0, 1, 2]
      // LIS: [0, 1, 2] (A, B, C don't move)
      const result = computeLIS([3, 0, 1, 2]);
      expect(result.length).toBe(3);
      expect(result).toEqual([1, 2, 3]);
    });

    it('should handle swap', () => {
      // Old: [A, B]
      // New: [B, A]
      // Old indices: [1, 0]
      // LIS: [0] or [1] (length 1)
      const result = computeLIS([1, 0]);
      expect(result.length).toBe(1);
    });

    it('should handle insert in middle', () => {
      // Old: [A, C]
      // New: [A, B, C]
      // Old indices: [0, -1, 1]
      // LIS: [0, 2] (A and C don't move)
      const result = computeLIS([0, -1, 1]);
      expect(result).toEqual([0, 2]);
    });
  });
});
