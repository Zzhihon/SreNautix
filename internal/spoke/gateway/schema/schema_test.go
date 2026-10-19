package schema_test

import (
	"context"
	"io/fs"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"sigs.k8s.io/yaml"

	contract "github.com/Zzhihon/SreNautix/contract/gateway"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/schema"
)

func TestContractSchemasCompile(t *testing.T) {
	entries, err := fs.ReadDir(contract.FS, "v1")
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".schema.json") {
			if _, err := schema.Get(e.Name()); err != nil {
				t.Fatal(err)
			}
			n++
		}
	}
	if n != 6 {
		t.Fatalf("expected 6 schemas, compiled %d", n)
	}
}

func TestActionCatalogMatchesSchema(t *testing.T) {
	doc, err := fs.ReadFile(contract.FS, "v1/action-catalog.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := schema.ValidateYAML(schema.ActionCatalog, doc); err != nil {
		t.Fatal(err)
	}
}

func TestActionExecutionCRDParses(t *testing.T) {
	doc, err := fs.ReadFile(contract.FS, "v1/crd/srenautix.io_actionexecutions.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var crd apiextensionsv1.CustomResourceDefinition
	if err := yaml.UnmarshalStrict(doc, &crd); err != nil {
		t.Fatal(err)
	}
	if crd.Name != "actionexecutions.srenautix.io" || len(crd.Spec.Versions) != 1 || crd.Spec.Versions[0].Subresources.Status == nil {
		t.Fatalf("unexpected CRD %s", crd.Name)
	}
}

func TestOpenAPIDocumentLoads(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "contract", "gateway", "v1", "openapi.yaml")
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = true
	doc, err := loader.LoadFromFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !doc.IsOpenAPI31OrLater() {
		t.Fatalf("openapi version %s", doc.OpenAPI)
	}
	for _, p := range []string{"/v1/spoke/tickets", "/v1/spoke/events", "/v1/spoke/proposals/{proposal_id}/binding", "/v1/spoke/heartbeat"} {
		if doc.Paths.Find(p) == nil {
			t.Fatalf("path %s missing", p)
		}
	}
}
