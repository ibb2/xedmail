using System.Text;
using System.Text.Json;
using Clerk.BackendAPI.Helpers.Jwks;

namespace xedmail.Authentication;

public class UserAuthentication
{
    public class ClerkValidationResult
    {
        public bool IsSignedIn { get; init; }
        public string UserId { get; init; }
        public string SessionId { get; init; }  // optional extra data
        public string Error { get; init; }
    }

    public async Task<ClerkValidationResult> ValidateSessionAsync(HttpRequest httpRequest)
    {
        Console.WriteLine("Validating session");
        
        var clerkSecretKey = Environment.GetEnvironmentVariable("CLERK_SECRET_KEY");
        var options = new AuthenticateRequestOptions(
            secretKey: clerkSecretKey,
            authorizedParties: new[] {"http://localhost:3000"}
        );
        var requestState = await AuthenticateRequest.AuthenticateRequestAsync(httpRequest, options);
        if (!requestState.IsSignedIn())
        {
            return new ClerkValidationResult { IsSignedIn = false, Error = requestState.ToString() };
        }
        
        SessionAuthObjectV2 auth = (SessionAuthObjectV2)requestState.ToAuth();

        var jwt = requestState.Token.Split(".")[1].Trim();
        var base64Url = Base64UrlToBase64(jwt);
        var sessionObj = Encoding.UTF8.GetString(Convert.FromBase64String(base64Url));
        var sessionJson = JsonSerializer.Deserialize<Dictionary<string, object>>(sessionObj);
        
        var userId = sessionJson?["sub"].ToString();
        var sessionId = auth.Sid;
        
        Console.WriteLine($"Session validated for user {userId}");
        
        return new ClerkValidationResult
        {
            IsSignedIn = true,
            UserId = userId,
            SessionId = sessionId
        };
    }
    
    string Base64UrlToBase64(string base64Url)
    {
        string padded = base64Url.Replace('-', '+').Replace('_', '/');
        switch (padded.Length % 4)
        {
            case 2: padded += "=="; break;
            case 3: padded += "="; break;
        }
        return padded;
    }
}