# Todo list

Declarations only (`.field`/`.edge`/`.node`/`.topology`), no `Fn` implementations — same as
[`person-birthday`](../person-birthday/) and [`recipe`](../recipe/). Exercises `allOf:` input
(a multi-edge readiness check) and `many` as a field type (`TodoList.tasks`), which
`person-birthday` doesn't use.

## `AddTodoToList` never fires in this topology — on purpose

`main.topology` wires `CreateTodo` to both `AddTodoToList` and `CompleteTodo`. `AddTodoToList`
declares `input: { allOf: [TodoList, Todo] }` — it needs a `TodoList` instance to already exist
before it can become ready. Nothing in this fixture ever produces one: there's no `.node` whose
output is `TodoList`, and no origin for it in `main.topology`. Running this topology through
`runtime.ts` fires `CreateTodo` and `CompleteTodo`, but `AddTodoToList` sits forever unready.

That's deliberate, not an oversight — it's exactly what `allOf`'s readiness semantics predict, and
`runtime.test.ts` has a test built around it
(`"runs the real todo-list topology — CompleteTodo fires from CreateTodo's output; AddTodoToList
never becomes ready"`). That same test file also shows what it takes to actually get
`AddTodoToList` to fire: injecting a `TodoList` log entry directly, bypassing this topology
entirely, to exercise `AddTodoToList`'s own success and `Failed_Todo_TodoList` failure paths in
isolation.

If this example ever grows a real `TodoList` origin (a `CreateTodoList` node, wired as a second root
in `main.topology`), `AddTodoToList` would start firing for real and this note goes away.
