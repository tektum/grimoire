variable "project_id" {
  description = "Id of the development project (a public value)."
  type        = string
  default     = "P3MKkY4NTeugh4LndRLzgCZJtoPS"
}

variable "approved_domains" {
  description = "Host names the sign-in may redirect to and send links for. Hosts only: the provider takes no port, so the web origin on 4173 and the stack on 8080 are both covered by 127.0.0.1."
  type        = set(string)
  default     = ["127.0.0.1", "localhost"]
}

variable "app_url" {
  description = "Origin of the web page for local runs."
  type        = string
  default     = "http://127.0.0.1:4173"
}
