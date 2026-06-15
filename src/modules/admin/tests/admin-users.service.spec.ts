import { NotFoundException } from '@nestjs/common';
import { AdminUsersService } from '../admin-users.service';
import type { AdminUsersRepository } from '../admin-users.repository';

const makeAdminUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'admin@masafashion.jo',
  passwordHash: '$2b$10$hashedpassword',
  role: 'admin',
  createdAt: new Date(),
  ...overrides,
});

describe('AdminUsersService', () => {
  const list = jest.fn();
  const findById = jest.fn();
  const findByEmail = jest.fn();
  const insert = jest.fn();
  const updateById = jest.fn();
  const deleteById = jest.fn();

  const repo = {
    list,
    findById,
    findByEmail,
    insert,
    updateById,
    deleteById,
  } as unknown as AdminUsersRepository;

  const service = new AdminUsersService(repo);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- getById ---

  it('getById returns the user when found', async () => {
    const user = makeAdminUser({ id: 'u1' });
    findById.mockResolvedValue(user);

    const result = await service.getById('u1');

    expect(result).toBe(user);
  });

  it('getById throws NotFoundException when the user does not exist', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.getById('missing')).rejects.toThrow(NotFoundException);
  });

  it('getById throws NotFoundException with a message containing the id', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.getById('abc-123')).rejects.toThrow('abc-123');
  });

  // --- getByEmail ---

  it('getByEmail returns the user when found', async () => {
    const user = makeAdminUser({ email: 'admin@masafashion.jo' });
    findByEmail.mockResolvedValue(user);

    const result = await service.getByEmail('admin@masafashion.jo');

    expect(result).toBe(user);
  });

  it('getByEmail returns undefined when the email is not found — no throw', async () => {
    findByEmail.mockResolvedValue(undefined);

    const result = await service.getByEmail('nobody@example.com');

    expect(result).toBeUndefined();
    // Confirm no exception was thrown by reaching this line
  });

  it('getByEmail does not throw even for a completely unknown email', async () => {
    findByEmail.mockResolvedValue(undefined);

    await expect(
      service.getByEmail('ghost@example.com'),
    ).resolves.toBeUndefined();
  });

  // --- create ---

  it('create delegates directly to the repo without modifying input', async () => {
    const user = makeAdminUser();
    insert.mockResolvedValue(user);

    const input = {
      email: 'new@masafashion.jo',
      passwordHash: 'hashed',
      role: 'editor' as const,
    };

    const result = await service.create(input);

    expect(insert).toHaveBeenCalledWith(input);
    expect(result).toBe(user);
  });
});
