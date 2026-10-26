package main

import (
 "fmt"
 "runtime"
)

func main() {
 fmt.Printf("rea-go-arm64-cloud os=%s arch=%s\n", runtime.GOOS, runtime.GOARCH)
}
