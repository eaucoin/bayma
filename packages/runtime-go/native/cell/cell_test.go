package cell

import (
	"reflect"
	"strings"
	"testing"
)

func TestSource(t *testing.T) {
	for _, test := range []struct {
		name, cell string
		want       []string // in order, in the package's source
	}{
		{
			name: "a declaring statement becomes a package variable",
			cell: "x := 41",
			want: []string{"var x = 41"},
		},
		{
			name: ":= reuses a name the cell declared through a temporary",
			cell: "a, err := f()\nb, err := g()",
			want: []string{
				"var a, err = f()",
				"var b, Bayma_temporary1 = g()",
				"err = Bayma_temporary1",
			},
		},
		{
			name: "declarations and statements keep their order",
			cell: "type t struct{ n int }\nv := t{}\nfunc (x *t) add() { x.n++ }\nv.add()\nv.n",
			want: []string{"type t struct", "var v = t{}", "func (x *t) add()", "var _ = func() struct{} {\nv.add()", "Bayma_values(v.n)"},
		},
		{
			name: "a final expression is the result",
			cell: "x := 1\nx + 1",
			want: []string{"var x = 1", "var Bayma_result = Bayma_values(x + 1)"},
		},
		{
			name: "a function literal called as a statement is not a declaration",
			cell: "func() { println(1) }()\n2",
			want: []string{"var _ = func() struct{} {\nfunc() { println(1) }()", "Bayma_values(2)"},
		},
		{
			name: "statements before a declaration are not its result",
			cell: "run()\nfunc run() {}",
			want: []string{"var _ = func() struct{} {\nrun()", "func run() {}"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			c, err := Parse(test.cell)
			if err != nil {
				t.Fatal(err)
			}
			source := c.Source("c0001", true)
			at := 0
			for _, want := range test.want {
				index := strings.Index(source[at:], want)
				if index < 0 {
					t.Fatalf("%q is not after offset %d in\n%s", want, at, source)
				}
				at += index + len(want)
			}
		})
	}
}

func TestImports(t *testing.T) {
	c, err := Parse("import (\n\t\"fmt\"\n\tgh \"github.com/google/go-github/v92/github\"\n)\nfmt.Println(gh.Ptr(1))")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"fmt", "github.com/google/go-github/v92/github"}; !reflect.DeepEqual(c.Imports(), want) {
		t.Fatalf("imports %v, want %v", c.Imports(), want)
	}
	if !c.BlankImport("fmt") || c.BlankImport("fmt") {
		t.Fatal("a blanked import is blanked once")
	}
	if !strings.Contains(c.Source("c0001", true), `import _ "fmt"`) {
		t.Fatal("the blanked import is in the source")
	}
}

func TestResultOnlyWhenTheCellEndsInAnExpression(t *testing.T) {
	c, _ := Parse("x := 1")
	if c.HasResult() {
		t.Fatal("a cell ending in a statement has no result")
	}
	c, _ = Parse("f()")
	if !c.HasResult() || strings.Contains(c.Source("c0001", false), "Bayma_values") {
		t.Fatal("a call's result runs as a statement when it returns nothing")
	}
}

func TestParseErrors(t *testing.T) {
	if _, err := Parse("x := "); err == nil {
		t.Fatal("an incomplete statement does not parse")
	}
}
