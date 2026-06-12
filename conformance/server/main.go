// Conformance echo server: a real grpc-gateway in front of a real gRPC
// service, configured like a production gateway (JSONPb with EmitUnpopulated,
// DiscardUnknown, AllowPartial; camelCase JSON names; raw google.api.HttpBody
// passthrough). Every response echoes back the fully decoded request message
// (as protojson) plus the wire-level method/path/query the gateway observed,
// so the TypeScript conformance suite can assert that what the client encoded
// is exactly what the server decoded.
package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"google.golang.org/genproto/googleapis/api/httpbody"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/structpb"

	pb "github.com/sentioxyz/connect-gateway-es/conformance/gen/connectgateway/testing"
)

type echoServer struct {
	pb.UnimplementedEchoServiceServer
}

func observed(ctx context.Context) *pb.EchoResponse {
	resp := &pb.EchoResponse{}
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		get := func(key string) string {
			if v := md.Get(key); len(v) > 0 {
				return v[0]
			}
			return ""
		}
		resp.ObservedMethod = get("observed-method")
		resp.ObservedPath = get("observed-path")
		resp.ObservedRawQuery = get("observed-query")
	}
	return resp
}

func decoded(m proto.Message) *structpb.Struct {
	b, err := protojson.Marshal(m)
	if err != nil {
		panic(err)
	}
	s := &structpb.Struct{}
	if err := protojson.Unmarshal(b, s); err != nil {
		panic(err)
	}
	return s
}

func echo(ctx context.Context, name string, req proto.Message) *pb.EchoResponse {
	resp := observed(ctx)
	resp.Message = name
	resp.DecodedRequest = decoded(req)
	return resp
}

func (s *echoServer) GetSimple(ctx context.Context, req *pb.GetSimpleRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "GetSimple", req), nil
}

func (s *echoServer) GetNested(ctx context.Context, req *pb.GetNestedRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "GetNested", req), nil
}

func (s *echoServer) GetWildcard(ctx context.Context, req *pb.GetWildcardRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "GetWildcard", req), nil
}

func (s *echoServer) GetPattern(ctx context.Context, req *pb.GetPatternRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "GetPattern", req), nil
}

func (s *echoServer) PostBody(ctx context.Context, req *pb.PostBodyRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "PostBody", req), nil
}

func (s *echoServer) PostNamedBody(ctx context.Context, req *pb.PostNamedBodyRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "PostNamedBody", req), nil
}

func (s *echoServer) PutBody(ctx context.Context, req *pb.PostBodyRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "PutBody", req), nil
}

func (s *echoServer) PatchBody(ctx context.Context, req *pb.PostBodyRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "PatchBody", req), nil
}

func (s *echoServer) DeleteSimple(ctx context.Context, req *pb.GetSimpleRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "DeleteSimple", req), nil
}

func (s *echoServer) MultiBind(ctx context.Context, req *pb.PostBodyRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "MultiBind", req), nil
}

func (s *echoServer) QueryKitchenSink(ctx context.Context, req *pb.KitchenSinkRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "QueryKitchenSink", req), nil
}

func (s *echoServer) GetRaw(ctx context.Context, req *pb.GetSimpleRequest) (*httpbody.HttpBody, error) {
	return &httpbody.HttpBody{
		ContentType: "text/x-raw; charset=utf-8",
		Data:        []byte("raw:" + req.Id),
	}, nil
}

func (s *echoServer) PostRaw(ctx context.Context, req *httpbody.HttpBody) (*httpbody.HttpBody, error) {
	contentType := ""
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if v := md.Get("observed-content-type"); len(v) > 0 {
			contentType = v[0]
		}
	}
	return &httpbody.HttpBody{ContentType: contentType, Data: req.Data}, nil
}

func (s *echoServer) Fail(ctx context.Context, req *pb.FailRequest) (*pb.EchoResponse, error) {
	st := status.New(codes.Code(req.Code), req.Message)
	if req.WithDetail {
		withDetails, err := st.WithDetails(durationpb.New(3 * time.Second))
		if err != nil {
			return nil, err
		}
		st = withDetails
	}
	return nil, st.Err()
}

func (s *echoServer) StreamEcho(req *pb.StreamEchoRequest, stream grpc.ServerStreamingServer[pb.EchoResponse]) error {
	for i := int32(1); i <= req.Count; i++ {
		if req.FailAt > 0 && i == req.FailAt {
			return status.Error(codes.Internal, "stream failed")
		}
		resp := echo(stream.Context(), "StreamEcho", req)
		resp.Sequence = i
		if err := stream.Send(resp); err != nil {
			return err
		}
	}
	return nil
}

func (s *echoServer) NoAnnotation(ctx context.Context, req *pb.GetSimpleRequest) (*pb.EchoResponse, error) {
	return echo(ctx, "NoAnnotation", req), nil
}

// rawBodyMarshaler decodes request bodies destined for google.api.HttpBody as
// raw bytes (the inbound counterpart of runtime.HTTPBodyMarshaler, which only
// handles responses) and delegates everything else to the wrapped marshaler.
type rawBodyMarshaler struct {
	runtime.Marshaler
}

func (m *rawBodyMarshaler) NewDecoder(r io.Reader) runtime.Decoder {
	return runtime.DecoderFunc(func(v interface{}) error {
		if hb, ok := v.(*httpbody.HttpBody); ok {
			data, err := io.ReadAll(r)
			if err != nil {
				return err
			}
			hb.Data = data
			return nil
		}
		return m.Marshaler.NewDecoder(r).Decode(v)
	})
}

func main() {
	ctx := context.Background()

	grpcLis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	grpcServer := grpc.NewServer()
	pb.RegisterEchoServiceServer(grpcServer, &echoServer{})
	go func() {
		if err := grpcServer.Serve(grpcLis); err != nil {
			fmt.Fprintln(os.Stderr, "grpc serve:", err)
			os.Exit(1)
		}
	}()

	jsonpb := &runtime.JSONPb{
		MarshalOptions:   protojson.MarshalOptions{EmitUnpopulated: true},
		UnmarshalOptions: protojson.UnmarshalOptions{DiscardUnknown: true, AllowPartial: true},
	}
	marshaler := &rawBodyMarshaler{&runtime.HTTPBodyMarshaler{Marshaler: jsonpb}}
	annotator := func(ctx context.Context, r *http.Request) metadata.MD {
		return metadata.Pairs(
			"observed-method", r.Method,
			"observed-path", r.URL.EscapedPath(),
			"observed-query", r.URL.RawQuery,
			"observed-content-type", r.Header.Get("Content-Type"),
		)
	}
	mux := runtime.NewServeMux(
		runtime.WithMarshalerOption(runtime.MIMEWildcard, marshaler),
		runtime.WithMetadata(annotator),
	)

	conn, err := grpc.NewClient(grpcLis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		panic(err)
	}
	if err := pb.RegisterEchoServiceHandler(ctx, mux, conn); err != nil {
		panic(err)
	}

	root := http.NewServeMux()
	root.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	root.Handle("/", mux)

	httpLis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	fmt.Printf("PORT=%d\n", httpLis.Addr().(*net.TCPAddr).Port)
	if err := http.Serve(httpLis, root); err != nil {
		panic(err)
	}
}
