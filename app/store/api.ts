import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      // 模拟真实远端：切列车/挂载时有一个请求在途窗口，结果回来前不得冻结
      async queryFn(id) {
        await delay(900);
        return { data: { ready: id !== 'offline', checkedAt: new Date().toISOString() } };
      }
    })
  })
});

export const { useGetTrainHealthQuery } = releaseApi;
