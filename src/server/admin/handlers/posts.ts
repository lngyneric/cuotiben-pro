import * as postsService from '@/modules/posts/service';
import { respData, respErr, respOk, respPage } from '@/lib/resp';

import type { AdminHandlerContext } from '../types';

export async function GET({ request, actor }: AdminHandlerContext) {
  try {
    const { searchParams } = new URL(request.url);

    // Single post (with content) — used by the editor
    const id = searchParams.get('id');
    if (id) {
      const post = await postsService.getById(id);
      if (!post) return respErr('Post not found');
      return respData(post);
    }

    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get('pageSize') || '20'))
    );
    const search = searchParams.get('search') || undefined;
    const status = searchParams.get('status') || undefined;

    const { items, total } = await postsService.list({
      search,
      status,
      page,
      pageSize,
    });
    return respPage(items, total);
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

export async function POST({ request, actor }: AdminHandlerContext) {
  try {
    const {
      slug,
      title,
      description,
      image,
      content,
      categories,
      tags,
      authorName,
      status,
    } = await request.json();
    if (!slug || !title) return respErr('slug and title are required');
    const result = await postsService.create({
      userId: actor.userId,
      slug,
      title,
      description,
      image,
      content,
      categories,
      tags,
      authorName,
      status,
    });
    return respData(result);
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

export async function PUT({ request, actor }: AdminHandlerContext) {
  try {
    const {
      id,
      slug,
      title,
      description,
      image,
      content,
      categories,
      tags,
      authorName,
      status,
    } = await request.json();
    if (!id) return respErr('ID is required');
    const result = await postsService.update(id, {
      slug,
      title,
      description,
      image,
      content,
      categories,
      tags,
      authorName,
      status,
    });
    return respData(result);
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

export async function DELETE({ request, actor }: AdminHandlerContext) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return respErr('ID is required');
    await postsService.remove(id);
    return respOk();
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

export async function batchStatus({ request, actor }: AdminHandlerContext) {
  try {
    const { ids, status } = await request.json();
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100)
      return respErr('ids must be a non-empty array of at most 100');
    if (status !== 'published' && status !== 'draft')
      return respErr('status must be published or draft');
    const updated = await postsService.updateStatusMany(ids, status);
    return respData({ updated });
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}
