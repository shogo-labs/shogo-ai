declare module '@ucast/sql' {
  import type { Condition, FieldCondition } from '@ucast/core'

  interface SqlQuery {
    where(field: string, operator: string, value: unknown): SqlQuery
  }

  type SqlOperator<T extends Condition = FieldCondition<any>> = (
    condition: T,
    query: SqlQuery,
  ) => SqlQuery

  interface SqlInterpreter {
    (condition: Condition, executor: unknown): [string, unknown[]]
  }

  const allInterpreters: Record<string, SqlOperator>
  const pg: Record<string, SqlOperator>
  const sqlite: Record<string, SqlOperator>

  function createSqlInterpreter(
    interpreters: Record<string, SqlOperator>,
  ): SqlInterpreter
}
