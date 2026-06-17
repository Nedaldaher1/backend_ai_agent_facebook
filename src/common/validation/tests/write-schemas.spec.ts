import { BadRequestException } from '@nestjs/common';
import {
  createAdminUserSchema,
  createMessageSchema,
  createOrderSchema,
  createProductSchema,
  parseOrThrow,
  updateProductSchema,
} from '@/common/validation';

/** A real (v4) UUID for the FK/uuid-column cases. */
const VALID_UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('shared write schemas', () => {
  describe('createProductSchema', () => {
    it('accepts a minimal valid product', () => {
      const parsed = createProductSchema.parse({
        name: 'عباءة سوداء',
        priceJod: '45.000',
      });
      expect(parsed.name).toBe('عباءة سوداء');
      expect(parsed.priceJod).toBe('45.000');
    });

    it('rejects a missing required field (name)', () => {
      expect(
        createProductSchema.safeParse({ priceJod: '45.000' }).success,
      ).toBe(false);
    });

    it('rejects a JOD price with more than three decimals', () => {
      expect(
        createProductSchema.safeParse({ name: 'X', priceJod: '1.2345' })
          .success,
      ).toBe(false);
    });

    it('rejects an unknown / hallucinated key (strict)', () => {
      expect(
        createProductSchema.safeParse({
          name: 'X',
          priceJod: '1.000',
          colour: 'red',
        }).success,
      ).toBe(false);
    });

    it('rejects server-managed fields — id is omitted, so strict rejects it', () => {
      expect(
        createProductSchema.safeParse({
          id: VALID_UUID,
          name: 'X',
          priceJod: '1.000',
        }).success,
      ).toBe(false);
    });
  });

  describe('updateProductSchema (partial)', () => {
    it('accepts a single-field patch', () => {
      expect(
        updateProductSchema.safeParse({ priceJod: '20.000' }).success,
      ).toBe(true);
    });

    it('still rejects unknown keys', () => {
      expect(updateProductSchema.safeParse({ bogus: 1 }).success).toBe(false);
    });
  });

  describe('createMessageSchema', () => {
    it('enforces the uuid format on the conversation FK', () => {
      expect(
        createMessageSchema.safeParse({
          conversationId: 'c1',
          role: 'customer',
        }).success,
      ).toBe(false);
    });

    it('accepts a valid uuid FK with an in-enum role', () => {
      expect(
        createMessageSchema.safeParse({
          conversationId: VALID_UUID,
          role: 'agent',
        }).success,
      ).toBe(true);
    });

    it('rejects a role outside the enum', () => {
      expect(
        createMessageSchema.safeParse({
          conversationId: VALID_UUID,
          role: 'bot',
        }).success,
      ).toBe(false);
    });
  });

  describe('createOrderSchema', () => {
    it('accepts an empty draft (every column is optional)', () => {
      expect(createOrderSchema.safeParse({}).success).toBe(true);
    });

    it('rejects a status outside the lifecycle enum', () => {
      expect(createOrderSchema.safeParse({ status: 'shipped' }).success).toBe(
        false,
      );
    });
  });

  describe('createAdminUserSchema', () => {
    it('rejects a malformed email', () => {
      expect(
        createAdminUserSchema.safeParse({
          email: 'not-an-email',
          passwordHash: 'h',
        }).success,
      ).toBe(false);
    });

    it('accepts a valid admin payload', () => {
      expect(
        createAdminUserSchema.safeParse({
          email: 'admin@masafashion.jo',
          passwordHash: 'h',
        }).success,
      ).toBe(true);
    });
  });

  describe('parseOrThrow', () => {
    it('returns the typed data on success', () => {
      expect(parseOrThrow(createOrderSchema, { status: 'draft' })).toEqual({
        status: 'draft',
      });
    });

    it('throws BadRequestException carrying the zod issues on failure', () => {
      expect.assertions(4);
      try {
        parseOrThrow(createProductSchema, { priceJod: '45.000' });
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as {
          message: string;
          issues: unknown[];
        };
        expect(response.message).toBe('Validation failed');
        expect(Array.isArray(response.issues)).toBe(true);
        expect(response.issues.length).toBeGreaterThan(0);
      }
    });
  });
});
