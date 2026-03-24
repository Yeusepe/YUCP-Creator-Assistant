async function test() {
  const url = "http://localhost:3000/api/auth/oauth2/consent";
  const body = {
    accept: true,
    oauth_query: "response_type=code&client_id=yucp-unity-creator&redirect_uri=https%3A%2F%2Frare-squid-409.convex.site%2Fapi%2Fyucp%2Foauth%2Fcallback&scope=cert%3Aissue%20profile%3Aread&state=Y6N7e7QCxBI3_t3tVlHnk8V_-py4ssDTkgKmKwyvoPI&code_challenge=mNSnNyhbYfnthLOhTlMQAblCqy0WYH6hrEwNunHgQ1U&code_challenge_method=S256&exp=1774132654&sig=3Hqp%2FCJDcYdHRhU3TwLPn50ZvD6UgrosYLXnBy6G0DQ%3D"
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    console.log(res.status, await res.text());
  } catch(e) { console.error(e) }
}
test();
