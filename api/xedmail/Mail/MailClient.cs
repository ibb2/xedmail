using MailKit;
using MailKit.Net.Imap;
using MailKit.Search;
using MailKit.Security;
using MimeKit;

namespace xedmail.Mail;

public class MailClient
{
    
    public ImapClient Client = new();

    public async Task Connect(string email, string authToken)
    {
        //OAuth
        Console.WriteLine("Connecting to Gmail IMAP server");
        Console.WriteLine($"Email: {email}");
        var oauth2 = new SaslMechanismOAuthBearer(email, authToken);
        
        await Client.ConnectAsync("imap.gmail.com", 993, SecureSocketOptions.SslOnConnect);
        await Client.AuthenticateAsync(oauth2);
        
        Console.WriteLine("Connected to Gmail IMAP server");
    }

    public async Task<List<MimeMessage>> GetInbox()
    {
        List<MimeMessage> messages = [];
        
        await Client.Inbox.OpenAsync(FolderAccess.ReadOnly);
        
        var uids = await Client.Inbox.SearchAsync(SearchQuery.All);

        foreach (var uid in uids.TakeLast(20))
        {
            var message = await Client.Inbox.GetMessageAsync(uid);
            messages.Add(message);
        }
        
        return messages;
    }

    public async Task Disconnect()
    {
        await Client.DisconnectAsync(true);
    }
}